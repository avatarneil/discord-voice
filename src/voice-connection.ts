/**
 * Discord Voice Connection Manager
 * Handles joining, leaving, listening, and speaking in voice channels
 * 
 * Features:
 * - Barge-in: Stops speaking when user starts talking
 * - Auto-reconnect heartbeat: Keeps connection alive
 * - Streaming STT: Real-time transcription with Deepgram
 */

import emojiRegex from "emoji-regex";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  EndBehaviorType,
  StreamType,
  type VoiceConnection,
  type AudioPlayer,
  type AudioReceiveStream,
} from "@discordjs/voice";
import type {
  VoiceChannel,
  StageChannel,
  GuildMember,
  VoiceBasedChannel,
} from "discord.js";
import { Readable, PassThrough } from "stream";
import { pipeline } from "stream/promises";
import * as prism from "prism-media";
import { WaveFile } from "wavefile";

import type { DiscordVoiceConfig } from "./config.js";
import type { TTSResult } from "./tts.js";
import type { STTResult } from "./stt.js";
import { getVadThreshold } from "./config.js";

import { SPEAK_COOLDOWN_VAD_MS, SPEAK_COOLDOWN_PROCESSING_MS, getRmsThreshold } from "./constants.js";
import { createSTTProvider, type STTProvider } from "./stt.js";
import { createTTSProvider, type TTSProvider } from "./tts.js";

/** Create Discord audio resource from TTS result; PCM is converted to WAV for playback */
function createResourceFromTTSResult(result: TTSResult): ReturnType<typeof createAudioResource> {
  if (result.format === "opus") {
    return createAudioResource(Readable.from(result.audioBuffer), {
      inputType: StreamType.OggOpus,
    });
  }
  if (result.format === "pcm") {
    const wav = new WaveFile();
    // wavefile expects sample values (-32768..32767), not raw bytes; convert Int16LE Buffer to Int16Array
    const samples = new Int16Array(
      result.audioBuffer.buffer,
      result.audioBuffer.byteOffset,
      result.audioBuffer.length / 2
    );
    wav.fromScratch(1, result.sampleRate, "16", samples);
    return createAudioResource(Readable.from(Buffer.from(wav.toBuffer())));
  }
  return createAudioResource(Readable.from(result.audioBuffer));
}

/** Detect quota/rate-limit errors that warrant trying a fallback TTS provider */
function isRetryableTtsError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("quota_exceeded") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    /"status":\s*"quota_exceeded"/.test(msg) ||
    /\b401\b/.test(msg) ||
    /\b429\b/.test(msg) ||
    /\b503\b/.test(msg)
  );
}

/** Detect STT errors that warrant trying a fallback (quota, rate limit, connection, Wyoming unreachable) */
function isRetryableSttError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("quota_exceeded") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    /\b401\b/.test(msg) ||
    /\b429\b/.test(msg) ||
    /\b503\b/.test(msg) ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("connection") ||
    lower.includes("timeout") ||
    lower.includes("unreachable") ||
    lower.includes("wyoming")
  );
}
import { StreamingSTTManager, createStreamingSTTProvider } from "./streaming-stt.js";
import { createStreamingTTSProvider, type StreamingTTSProvider } from "./streaming-tts.js";

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
}

interface UserAudioState {
  chunks: Buffer[];
  lastActivityMs: number;
  isRecording: boolean;
  silenceTimer?: ReturnType<typeof setTimeout>;
  opusStream?: AudioReceiveStream;
  decoder?: prism.opus.Decoder;
}

export interface VoiceSession {
  guildId: string;
  channelId: string;
  channelName?: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  userAudioStates: Map<string, UserAudioState>;
  speaking: boolean;
  processing: boolean;           // Lock to prevent concurrent processing
  lastSpokeAt?: number;          // Timestamp when bot finished speaking (for cooldown)
  startedSpeakingAt?: number;    // Timestamp when bot started speaking (for echo suppression)
  thinkingPlayer?: AudioPlayer;  // Separate player for thinking sound
  heartbeatInterval?: ReturnType<typeof setInterval>;
  lastHeartbeat?: number;
  reconnecting?: boolean;
  /** Fallback TTS provider to use for rest of session (set after primary fails with quota/rate limit) */
  fallbackTtsProvider?: "openai" | "elevenlabs" | "deepgram" | "polly" | "kokoro" | "edge";
  /** Fallback STT provider to use for rest of session (set after primary fails) */
  fallbackSttProvider?: "whisper" | "gpt4o-mini" | "gpt4o-transcribe" | "gpt4o-transcribe-diarize" | "deepgram" | "local-whisper" | "wyoming-whisper";
  /** Set when agent used discord_voice speak tool – skip speaking returned text to avoid duplicate */
  spokeViaToolThisRun?: boolean;
}

export class VoiceConnectionManager {
  private sessions: Map<string, VoiceSession> = new Map();
  private config: DiscordVoiceConfig;
  private sttProvider: STTProvider | null = null;
  private streamingSTT: StreamingSTTManager | null = null;
  private ttsProvider: TTSProvider | null = null;
  private streamingTTS: StreamingTTSProvider | null = null;
  private logger: Logger;
  private onTranscript: (userId: string, guildId: string, channelId: string, text: string) => Promise<string>;

  // Heartbeat configuration (can be overridden via config.heartbeatIntervalMs)
  private readonly DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;  // 30 seconds
  private readonly HEARTBEAT_TIMEOUT_MS = 60_000;   // 60 seconds before reconnect
  private readonly MAX_RECONNECT_ATTEMPTS = 3;
  
  private get HEARTBEAT_INTERVAL_MS(): number {
    return this.config.heartbeatIntervalMs ?? this.DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  constructor(
    config: DiscordVoiceConfig,
    logger: Logger,
    onTranscript: (userId: string, guildId: string, channelId: string, text: string) => Promise<string>
  ) {
    this.config = config;
    this.logger = logger;
    this.onTranscript = onTranscript;
  }

  /**
   * Mark that the agent spoke via discord_voice tool during this transcript run.
   * processRecording will skip speaking the returned text to avoid duplicate playback.
   */
  markSpokeViaTool(guildId: string): void {
    const session = this.sessions.get(guildId);
    if (session) {
      session.spokeViaToolThisRun = true;
      this.logger.debug?.("[discord-voice] Agent spoke via discord_voice tool, will skip final speak");
    }
  }

  /**
   * Initialize providers lazily
   */
  private ensureProviders(): void {
    if (!this.sttProvider) {
      this.sttProvider = createSTTProvider(this.config);
    }
    if (!this.ttsProvider) {
      this.ttsProvider = createTTSProvider(this.config);
    }
    // Initialize streaming TTS (always, for lower latency)
    if (!this.streamingTTS) {
      this.streamingTTS = createStreamingTTSProvider(this.config);
    }
    // Initialize streaming STT if using Deepgram with streaming enabled
    if (!this.streamingSTT && this.config.sttProvider === "deepgram" && this.config.streamingSTT) {
      this.streamingSTT = createStreamingSTTProvider(this.config, this.logger);
    }
  }

  /**
   * Join a voice channel
   */
  async join(channel: VoiceBasedChannel): Promise<VoiceSession> {
    const existingSession = this.sessions.get(channel.guildId);
    if (existingSession) {
      if (existingSession.channelId === channel.id) {
        return existingSession;
      }
      // Leave current channel first
      await this.leave(channel.guildId);
    }

    this.ensureProviders();

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // We need to hear users
      selfMute: false,
    });

    const player = createAudioPlayer();
    connection.subscribe(player);

    const session: VoiceSession = {
      guildId: channel.guildId,
      channelId: channel.id,
      channelName: channel.name,
      connection,
      player,
      userAudioStates: new Map(),
      speaking: false,
      processing: false,
      lastHeartbeat: Date.now(),
    };

    this.sessions.set(channel.guildId, session);

    // Wait for the connection to be ready
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      this.logger.info(`[discord-voice] Joined voice channel ${channel.name} in ${channel.guild.name}`);
    } catch (error) {
      connection.destroy();
      this.sessions.delete(channel.guildId);
      throw new Error(`Failed to join voice channel: ${error}`);
    }

    // Start listening to users
    this.startListening(session);

    // Start heartbeat for connection health monitoring
    this.startHeartbeat(session);

    // Handle connection state changes
    this.setupConnectionHandlers(session, channel);

    return session;
  }

  /**
   * Setup connection event handlers for auto-reconnect
   */
  private setupConnectionHandlers(session: VoiceSession, channel: VoiceBasedChannel): void {
    const connection = session.connection;

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (session.reconnecting) return;
      
      this.logger.warn(`[discord-voice] Disconnected from voice channel in ${channel.guild.name}`);
      
      try {
        // Try to reconnect within 5 seconds
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        this.logger.info(`[discord-voice] Reconnecting to voice channel...`);
      } catch {
        // Connection is not recovering, attempt manual reconnect
        await this.attemptReconnect(session, channel);
      }
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
      session.lastHeartbeat = Date.now();
      session.reconnecting = false;
      this.logger.info(`[discord-voice] Connection ready for ${channel.name}`);
    });

    connection.on("error", (error) => {
      this.logger.error(`[discord-voice] Connection error: ${error.message}`);
    });
  }

  /**
   * Attempt to reconnect to voice channel
   */
  private async attemptReconnect(session: VoiceSession, channel: VoiceBasedChannel, attempt = 1): Promise<void> {
    if (attempt > this.MAX_RECONNECT_ATTEMPTS) {
      this.logger.error(`[discord-voice] Max reconnection attempts reached, giving up`);
      await this.leave(session.guildId);
      return;
    }

    session.reconnecting = true;
    this.logger.info(`[discord-voice] Reconnection attempt ${attempt}/${this.MAX_RECONNECT_ATTEMPTS}`);

    try {
      // Destroy old connection
      session.connection.destroy();

      // Wait before reconnecting (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));

      // Create new connection
      const newConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      const newPlayer = createAudioPlayer();
      newConnection.subscribe(newPlayer);

      // Update session
      session.connection = newConnection;
      session.player = newPlayer;

      // Wait for ready
      await entersState(newConnection, VoiceConnectionStatus.Ready, 20_000);
      
      session.reconnecting = false;
      session.lastHeartbeat = Date.now();
      
      // Restart listening
      this.startListening(session);
      
      // Setup handlers for new connection
      this.setupConnectionHandlers(session, channel);
      
      this.logger.info(`[discord-voice] Reconnected successfully`);
    } catch (error) {
      this.logger.error(`[discord-voice] Reconnection failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.attemptReconnect(session, channel, attempt + 1);
    }
  }

  /**
   * Start heartbeat monitoring for session
   */
  private startHeartbeat(session: VoiceSession): void {
    // Clear any existing heartbeat
    if (session.heartbeatInterval) {
      clearInterval(session.heartbeatInterval);
    }

    session.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const connectionState = session.connection.state.status;
      
      // Update heartbeat if connection is healthy
      if (connectionState === VoiceConnectionStatus.Ready) {
        session.lastHeartbeat = now;
        this.logger.debug?.(`[discord-voice] Heartbeat OK for guild ${session.guildId}`);
      } else if (session.lastHeartbeat && (now - session.lastHeartbeat > this.HEARTBEAT_TIMEOUT_MS)) {
        // Connection has been unhealthy for too long
        this.logger.warn(`[discord-voice] Heartbeat timeout, connection state: ${connectionState}`);
        
        // Don't attempt reconnect if already doing so
        if (!session.reconnecting) {
          // Trigger reconnection by destroying and rejoining
          this.logger.info(`[discord-voice] Triggering reconnection due to heartbeat timeout`);
          session.connection.destroy();
        }
      }
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Leave a voice channel
   */
  async leave(guildId: string): Promise<boolean> {
    const session = this.sessions.get(guildId);
    if (!session) {
      return false;
    }

    // Clear heartbeat
    if (session.heartbeatInterval) {
      clearInterval(session.heartbeatInterval);
    }

    // Clear all user timers and streams
    for (const state of session.userAudioStates.values()) {
      if (state.silenceTimer) {
        clearTimeout(state.silenceTimer);
      }
      if (state.opusStream) {
        state.opusStream.destroy();
      }
      if (state.decoder) {
        state.decoder.destroy();
      }
    }

    // Close streaming STT sessions
    if (this.streamingSTT) {
      for (const userId of session.userAudioStates.keys()) {
        this.streamingSTT.closeSession(userId);
      }
    }

    session.connection.destroy();
    this.sessions.delete(guildId);
    this.logger.info(`[discord-voice] Left voice channel in guild ${guildId}`);
    return true;
  }

  /**
   * Start listening to voice in the channel
   */
  private startListening(session: VoiceSession): void {
    const receiver = session.connection.receiver;

    receiver.speaking.on("start", (userId: string) => {
      if (!this.isUserAllowed(userId)) {
        return;
      }

      // Ignore audio during cooldown period (prevents echo from triggering)
      if (session.lastSpokeAt && (Date.now() - session.lastSpokeAt) < SPEAK_COOLDOWN_VAD_MS) {
        this.logger.debug?.(`[discord-voice] Ignoring speech during cooldown (likely echo)`);
        return;
      }

      this.logger.debug?.(`[discord-voice] User ${userId} started speaking`);
      
      // ═══════════════════════════════════════════════════════════════
      // BARGE-IN / ECHO SUPPRESSION
      // Discord's voice detection can't distinguish between the user talking
      // and echo from the bot's own audio playback. We disable barge-in while
      // speaking to prevent the bot from interrupting itself.
      // ═══════════════════════════════════════════════════════════════
      if (session.speaking) {
        // While bot is actively speaking, ignore all speech events
        // This prevents echo from triggering barge-in
        this.logger.debug?.(`[discord-voice] Ignoring speech while bot is speaking (echo suppression)`);
        return;
      }
      
      if (session.processing) {
        // While processing a request, don't start new recordings
        // Clear any accumulated streaming transcripts to prevent stale text
        if (this.streamingSTT) {
          this.streamingSTT.closeSession(userId);
        }
        this.logger.debug?.(`[discord-voice] Ignoring speech while processing`);
        return;
      }

      let state = session.userAudioStates.get(userId);
      if (!state) {
        state = {
          chunks: [],
          lastActivityMs: Date.now(),
          isRecording: false,
        };
        session.userAudioStates.set(userId, state);
      }

      // Clear any existing silence timer
      if (state.silenceTimer) {
        clearTimeout(state.silenceTimer);
        state.silenceTimer = undefined;
      }

      if (!state.isRecording) {
        state.isRecording = true;
        state.chunks = [];
        this.startRecording(session, userId);
      }

      state.lastActivityMs = Date.now();
    });

    receiver.speaking.on("end", (userId: string) => {
      if (!this.isUserAllowed(userId)) {
        return;
      }

      this.logger.debug?.(`[discord-voice] User ${userId} stopped speaking`);
      
      const state = session.userAudioStates.get(userId);
      if (!state || !state.isRecording) {
        return;
      }

      state.lastActivityMs = Date.now();

      // Set silence timer to process the recording
      state.silenceTimer = setTimeout(async () => {
        if (state.isRecording) {
          const chunksToProcess = [...state.chunks];
          state.isRecording = false;
          state.chunks = [];
          
          // Clean up streams
          if (state.opusStream) {
            state.opusStream.destroy();
            state.opusStream = undefined;
          }
          if (state.decoder) {
            state.decoder.destroy();
            state.decoder = undefined;
          }
          
          if (chunksToProcess.length > 0) {
            await this.processRecording(session, userId, chunksToProcess);
          }
        }
      }, this.config.silenceThresholdMs);
    });
  }

  /**
   * Stop any current speech output (for barge-in)
   */
  private stopSpeaking(session: VoiceSession): void {
    // Stop main player
    if (session.player.state.status !== AudioPlayerStatus.Idle) {
      session.player.stop(true);
    }
    
    // Stop thinking player if active
    if (session.thinkingPlayer && session.thinkingPlayer.state.status !== AudioPlayerStatus.Idle) {
      session.thinkingPlayer.stop(true);
      session.thinkingPlayer.removeAllListeners();
      session.thinkingPlayer = undefined;
    }

    session.speaking = false;
  }

  /**
   * Start recording audio from a user
   */
  private startRecording(session: VoiceSession, userId: string): void {
    const state = session.userAudioStates.get(userId);
    if (!state) return;

    const opusStream = session.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.Manual,
      },
    });

    // Handle stream errors to prevent crashes
    opusStream.on("error", (error) => {
      this.logger.error(`[discord-voice] AudioReceiveStream error for user ${userId}: ${error.message}`);
    });

    state.opusStream = opusStream;

    // Decode Opus to PCM
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 1,
      frameSize: 960,
    });

    state.decoder = decoder;
    opusStream.pipe(decoder);

    // If streaming STT is available and enabled, use it
    const useStreaming = this.streamingSTT && this.config.sttProvider === "deepgram" && this.config.streamingSTT;
    
    if (useStreaming && this.streamingSTT) {
      // Create streaming session for this user
      const streamingSession = this.streamingSTT.getOrCreateSession(userId, (text, isFinal) => {
        if (isFinal) {
          this.logger.debug?.(`[discord-voice] Streaming transcript (final): "${text}"`);
        } else {
          this.logger.debug?.(`[discord-voice] Streaming transcript (interim): "${text}"`);
        }
      });

      decoder.on("data", (chunk: Buffer) => {
        if (state.isRecording) {
          // Send to streaming STT
          this.streamingSTT?.sendAudio(userId, chunk);
          
          // Also buffer for fallback/debugging
          state.chunks.push(chunk);
          state.lastActivityMs = Date.now();

          // Check max recording length
          const totalSize = state.chunks.reduce((sum, c) => sum + c.length, 0);
          const durationMs = (totalSize / 2) / 48; // 16-bit samples at 48kHz
          if (durationMs >= this.config.maxRecordingMs) {
            this.logger.debug?.(`[discord-voice] Max recording length reached for user ${userId}`);
            state.isRecording = false;
            
            if (state.opusStream) {
              state.opusStream.destroy();
              state.opusStream = undefined;
            }
            if (state.decoder) {
              state.decoder.destroy();
              state.decoder = undefined;
            }

            this.processRecording(session, userId, [...state.chunks]);
            state.chunks = [];
          }
        }
      });
    } else {
      // Batch mode - just buffer audio
      decoder.on("data", (chunk: Buffer) => {
        if (state.isRecording) {
          state.chunks.push(chunk);
          state.lastActivityMs = Date.now();

          // Check max recording length
          const totalSize = state.chunks.reduce((sum, c) => sum + c.length, 0);
          const durationMs = (totalSize / 2) / 48; // 16-bit samples at 48kHz
          if (durationMs >= this.config.maxRecordingMs) {
            this.logger.debug?.(`[discord-voice] Max recording length reached for user ${userId}`);
            state.isRecording = false;

            if (state.opusStream) {
              state.opusStream.destroy();
              state.opusStream = undefined;
            }
            if (state.decoder) {
              state.decoder.destroy();
              state.decoder = undefined;
            }

            this.processRecording(session, userId, [...state.chunks]);
            state.chunks = [];
          }
        }
      });
    }

    decoder.on("end", () => {
      this.logger.debug?.(`[discord-voice] Decoder stream ended for user ${userId}`);
    });

    decoder.on("error", (error: Error) => {
      this.logger.error(`[discord-voice] Decoder error for user ${userId}: ${error.message}`);
    });
  }

  /**
   * Process recorded audio through STT and get response
   */
  private async processRecording(session: VoiceSession, userId: string, chunks: Buffer[]): Promise<void> {
    if (!this.sttProvider || !this.ttsProvider) {
      return;
    }

    // Skip if already speaking (prevents overlapping responses)
    if (session.speaking) {
      this.logger.debug?.(`[discord-voice] Skipping processing - already speaking`);
      return;
    }

    // Skip if already processing another request (prevents duplicate responses)
    if (session.processing) {
      this.logger.debug?.(`[discord-voice] Skipping processing - already processing another request`);
      return;
    }

    // Cooldown after speaking to prevent echo/accidental triggers
    if (session.lastSpokeAt && (Date.now() - session.lastSpokeAt) < SPEAK_COOLDOWN_PROCESSING_MS) {
      this.logger.debug?.(`[discord-voice] Skipping processing - in cooldown period after speaking`);
      return;
    }

    const audioBuffer = Buffer.concat(chunks);
    
    // Skip very short recordings (likely noise) - check BEFORE setting processing lock
    const durationMs = (audioBuffer.length / 2) / 48; // 16-bit samples at 48kHz
    if (durationMs < this.config.minAudioMs) {
      this.logger.debug?.(`[discord-voice] Skipping short recording (${Math.round(durationMs)}ms < ${this.config.minAudioMs}ms) for user ${userId}`);
      return;
    }

    // Calculate RMS amplitude to filter out quiet sounds (keystrokes, background noise)
    const rms = this.calculateRMS(audioBuffer);
    const minRMS = getRmsThreshold(this.config.vadSensitivity);
    if (rms < minRMS) {
      this.logger.debug?.(`[discord-voice] Skipping quiet audio (RMS ${Math.round(rms)} < ${minRMS}) for user ${userId}`);
      return;
    }

    // Set processing lock AFTER passing all filters
    session.processing = true;
    session.spokeViaToolThisRun = false;

    this.logger.info(`[discord-voice] Processing ${Math.round(durationMs)}ms of audio (RMS: ${Math.round(rms)}) from user ${userId}`);

    try {
      let transcribedText = "";
      const fallbackList = this.config.sttFallbackProviders ?? [];

      const tryFallbacks = async (): Promise<string> => {
        for (const provider of fallbackList) {
          try {
            const r = await this.tryTranscribeWithProvider(audioBuffer, 48000, provider);
            if (r.text?.trim()) {
              session.fallbackSttProvider = provider;
              this.logger.info(`[discord-voice] Using fallback STT: ${provider} (session will stay on fallback)`);
              return r.text;
            }
          } catch (fbErr) {
            this.logger.warn(`[discord-voice] Fallback STT ${provider} failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`);
          }
        }
        return "";
      };

      if (session.fallbackSttProvider) {
        try {
          const r = await this.tryTranscribeWithProvider(audioBuffer, 48000, session.fallbackSttProvider);
          transcribedText = r.text ?? "";
          if (!transcribedText?.trim()) session.fallbackSttProvider = undefined;
        } catch (fbErr) {
          this.logger.warn(`[discord-voice] Session fallback STT failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`);
          session.fallbackSttProvider = undefined;
        }
      }

      if (!transcribedText) {
      // Check if we have streaming transcript available
      if (this.streamingSTT && this.config.sttProvider === "deepgram" && this.config.streamingSTT) {
        // Get accumulated transcript from streaming session
        transcribedText = this.streamingSTT.finalizeSession(userId);
        
        // Fallback to batch if streaming didn't capture anything
        if (!transcribedText || transcribedText.trim().length === 0) {
          this.logger.debug?.(`[discord-voice] Streaming empty, falling back to batch STT`);
            try {
              const r = await this.sttProvider.transcribe(audioBuffer, 48000);
              transcribedText = r.text ?? "";
            } catch (batchErr) {
              if (fallbackList.length > 0 && isRetryableSttError(batchErr)) {
                this.logger.warn(`[discord-voice] Primary STT failed, trying fallbacks: [${fallbackList.join(", ")}]`);
                transcribedText = await tryFallbacks();
              } else throw batchErr;
            }
        }
      } else {
        try {
          const r = await this.sttProvider.transcribe(audioBuffer, 48000);
          transcribedText = r.text ?? "";
        } catch (batchErr) {
          if (fallbackList.length > 0 && isRetryableSttError(batchErr)) {
            this.logger.warn(`[discord-voice] Primary STT failed, trying fallbacks: [${fallbackList.join(", ")}]`);
            transcribedText = await tryFallbacks();
          } else throw batchErr;
        }
        }
      }

      if (!transcribedText || transcribedText.trim().length === 0) {
        this.logger.debug?.(`[discord-voice] Empty transcription for user ${userId}`);
        session.processing = false;
        return;
      }

      this.logger.info(`[discord-voice] Transcribed: "${transcribedText}"`);

      // Play looping thinking sound while processing (if enabled)
      const stopThinking = await this.startThinkingLoop(session);

      let response: string;
      try {
        // Get response from agent
        response = await this.onTranscript(userId, session.guildId, session.channelId, transcribedText);
      } finally {
        // Always stop thinking sound, even on error
        stopThinking();
        const delayMs = this.config.thinkingSound?.stopDelayMs ?? 50;
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
      
      if (!response || response.trim().length === 0) {
        session.processing = false;
        return;
      }

      // Skip if agent already spoke via discord_voice tool (avoids duplicate playback)
      if (session.spokeViaToolThisRun) {
        this.logger.debug?.("[discord-voice] Skipping speak – agent already spoke via discord_voice tool");
        session.processing = false;
        return;
      }

      // Ensure main player is subscribed before speaking
      session.connection.subscribe(session.player);
      
      // Synthesize and play response
      await this.speak(session.guildId, response);
    } catch (error) {
      this.logger.error(`[discord-voice] Error processing audio: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      session.processing = false;
    }
  }

  /**
   * Try to transcribe using a specific STT provider (for fallback)
   */
  private async tryTranscribeWithProvider(
    audioBuffer: Buffer,
    sampleRate: number,
    provider: "whisper" | "gpt4o-mini" | "gpt4o-transcribe" | "gpt4o-transcribe-diarize" | "deepgram" | "local-whisper" | "wyoming-whisper"
  ): Promise<STTResult> {
    const overrideConfig = { ...this.config, sttProvider: provider };
    const stt = createSTTProvider(overrideConfig);
    return stt.transcribe(audioBuffer, sampleRate);
  }

  /**
   * Try to get an audio resource using a specific TTS provider (for fallback)
   */
  private async tryGetResourceWithProvider(
    text: string,
    provider: "openai" | "elevenlabs" | "deepgram" | "polly" | "kokoro" | "edge"
  ): Promise<ReturnType<typeof createAudioResource> | null> {
    const overrideConfig = { ...this.config, ttsProvider: provider };
    const fallbackTts = createTTSProvider(overrideConfig);
    const fallbackStreaming = createStreamingTTSProvider(overrideConfig);

    // Try streaming first (OpenAI/ElevenLabs only)
    if (fallbackStreaming) {
      try {
        const streamResult = await fallbackStreaming.synthesizeStream(text);
        if (streamResult.format === "opus") {
          return createAudioResource(streamResult.stream, { inputType: StreamType.OggOpus });
        }
        return createAudioResource(streamResult.stream);
      } catch {
        // Fall through to batch
      }
    }

    // Batch
    const ttsResult = await fallbackTts.synthesize(text);
    return createResourceFromTTSResult(ttsResult);
  }

  /**
   * Speak text in the voice channel
   */
  async speak(guildId: string, text: string): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session) {
      throw new Error("Not connected to voice channel");
    }

    // If thinking sound is playing (e.g. agent called discord_voice speak tool during run),
    // stop it and re-subscribe to main player so our audio is actually heard
    if (session.thinkingPlayer && session.thinkingPlayer.state.status !== AudioPlayerStatus.Idle) {
      session.thinkingPlayer.removeAllListeners();
      session.thinkingPlayer.stop(true);
      session.thinkingPlayer = undefined;
      session.connection.subscribe(session.player);
    }

    // Strip emojis before TTS when noEmojiHint is set (avoids Kokoro/others reading them aloud)
    if (this.config.noEmojiHint !== false) {
      text = text.replace(emojiRegex(), "").replace(/\s{2,}/g, " ").trim();
    }

    this.ensureProviders();

    if (!this.streamingTTS && !this.ttsProvider) {
      throw new Error("TTS provider not initialized");
    }

    session.speaking = true;
    session.startedSpeakingAt = Date.now();

    const waitForPlayback = () =>
      new Promise<void>((resolve) => {
        const onIdle = () => {
          session.speaking = false;
          session.lastSpokeAt = Date.now();
          session.player.off(AudioPlayerStatus.Idle, onIdle);
          session.player.off("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          this.logger.error(`[discord-voice] Playback error: ${error.message}`);
          session.speaking = false;
          session.lastSpokeAt = Date.now();
          session.player.off(AudioPlayerStatus.Idle, onIdle);
          session.player.off("error", onError);
          resolve();
        };
        session.player.on(AudioPlayerStatus.Idle, onIdle);
        session.player.on("error", onError);
      });

    try {
      this.logger.info(`[discord-voice] Speaking: "${text.substring(0, 50)}${text.length > 50 ? "..." : ""}"`);

      let resource: ReturnType<typeof createAudioResource> | null = null;
      const fallbackList = this.config.ttsFallbackProviders ?? [];

      const tryFallbacks = async (): Promise<ReturnType<typeof createAudioResource> | null> => {
        for (const provider of fallbackList) {
          try {
            const r = await this.tryGetResourceWithProvider(text, provider);
            if (r) {
              session.fallbackTtsProvider = provider;
              this.logger.info(
                `[discord-voice] Using fallback TTS: ${provider} (session will stay on fallback)`
              );
              return r;
            }
          } catch (fbErr) {
            this.logger.warn(
              `[discord-voice] Fallback ${provider} failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`
            );
          }
        }
        return null;
      };

      // If session already switched to fallback (e.g. quota hit earlier), use it for rest of session
      if (session.fallbackTtsProvider) {
        try {
          resource = await this.tryGetResourceWithProvider(text, session.fallbackTtsProvider);
          if (resource) {
            this.logger.debug?.(`[discord-voice] Using fallback TTS (session): ${session.fallbackTtsProvider}`);
          } else {
            session.fallbackTtsProvider = undefined;
          }
        } catch (fbErr) {
          this.logger.warn(
            `[discord-voice] Session fallback TTS failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`
          );
          session.fallbackTtsProvider = undefined;
        }
      }

      // Try primary: streaming first, then batch (only when not already on fallback)
      if (!resource && this.streamingTTS) {
        try {
          const streamResult = await this.streamingTTS.synthesizeStream(text);
          if (streamResult.format === "opus") {
            resource = createAudioResource(streamResult.stream, { inputType: StreamType.OggOpus });
          } else {
            resource = createAudioResource(streamResult.stream);
          }
          this.logger.debug?.(`[discord-voice] Using streaming TTS`);
        } catch (streamError) {
          this.logger.warn(
            `[discord-voice] Streaming TTS failed, falling back to buffered: ${streamError instanceof Error ? streamError.message : String(streamError)}`
          );
          if (fallbackList.length > 0 && isRetryableTtsError(streamError)) {
            this.logger.warn(
              `[discord-voice] Primary TTS failed (quota/rate limit), trying fallbacks: [${fallbackList.join(", ")}]`
            );
            resource = await tryFallbacks();
          }
        }
      }

      if (!resource && this.ttsProvider) {
        try {
          const ttsResult = await this.ttsProvider.synthesize(text);
          resource = createResourceFromTTSResult(ttsResult);
          this.logger.debug?.(`[discord-voice] Using buffered TTS`);
        } catch (batchError) {
          if (fallbackList.length > 0 && isRetryableTtsError(batchError)) {
            this.logger.warn(
              `[discord-voice] Primary TTS failed (quota/rate limit), trying fallbacks: [${fallbackList.join(", ")}]`
            );
            resource = await tryFallbacks();
          }
          if (!resource) throw batchError;
        }
      }

      if (!resource) {
        throw new Error("Failed to create audio resource");
      }

      session.player.play(resource);
      await waitForPlayback();
    } catch (error) {
      session.speaking = false;
      session.lastSpokeAt = Date.now();
      throw error;
    }
  }

  /**
   * Start looping thinking sound, returns stop function
   * No-op if disabled or file not found
   */
  private async startThinkingLoop(session: VoiceSession): Promise<() => void> {
    const ts = this.config.thinkingSound;
    if (ts?.enabled === false) return () => {};

    let stopped = false;
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const pluginRoot = path.join(__dirname, "..");
      const pathRaw = ts?.path ?? "assets/thinking.mp3";
      const thinkingPath = path.isAbsolute(pathRaw) ? pathRaw : path.join(pluginRoot, pathRaw);

      if (!fs.existsSync(thinkingPath)) {
        return () => {};
      }

      const audioData = fs.readFileSync(thinkingPath);
      const volume = typeof ts?.volume === "number" && ts.volume >= 0 && ts.volume <= 1 ? ts.volume : 0.7;

      // Create separate player for thinking sound
      const thinkingPlayer = createAudioPlayer();
      session.thinkingPlayer = thinkingPlayer;
      session.connection.subscribe(thinkingPlayer);

      const playLoop = () => {
        if (stopped || !thinkingPlayer) return;
        const resource = createAudioResource(Readable.from(Buffer.from(audioData)), {
          inlineVolume: true,
        });
        resource.volume?.setVolume(volume);
        thinkingPlayer.play(resource);
      };

      thinkingPlayer.on(AudioPlayerStatus.Idle, playLoop);
      playLoop(); // Start first play

      return () => {
        stopped = true;
        if (thinkingPlayer) {
          thinkingPlayer.removeAllListeners();
          thinkingPlayer.stop(true);
        }
        session.thinkingPlayer = undefined;
        // Re-subscribe main player immediately
        session.connection.subscribe(session.player);
      };
    } catch (error) {
      this.logger.debug?.(`[discord-voice] Error starting thinking loop: ${error instanceof Error ? error.message : String(error)}`);
      return () => {
        session.thinkingPlayer = undefined;
        session.connection.subscribe(session.player);
      };
    }
  }

  /**
   * Calculate RMS (Root Mean Square) amplitude of audio buffer
   * Used to filter out quiet sounds like keystrokes and background noise
   */
  private calculateRMS(audioBuffer: Buffer): number {
    // Audio is 16-bit signed PCM
    const samples = audioBuffer.length / 2;
    if (samples === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < audioBuffer.length; i += 2) {
      const sample = audioBuffer.readInt16LE(i);
      sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / samples);
  }

  /**
   * Check if a user is allowed to use voice
   */
  private isUserAllowed(userId: string): boolean {
    if (this.config.allowedUsers.length === 0) {
      return true;
    }
    return this.config.allowedUsers.includes(userId);
  }

  /**
   * Get session for a guild
   */
  getSession(guildId: string): VoiceSession | undefined {
    return this.sessions.get(guildId);
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): VoiceSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Destroy all connections
   */
  async destroy(): Promise<void> {
    // Close streaming STT
    if (this.streamingSTT) {
      this.streamingSTT.closeAll();
    }

    const guildIds = Array.from(this.sessions.keys());
    for (const guildId of guildIds) {
      await this.leave(guildId);
    }
  }
}
