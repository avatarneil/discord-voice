/**
 * Text-to-Speech providers
 */

import type { DiscordVoiceConfig } from "./config.js";
import { validateElevenLabsVoiceId, validateKokoroModel } from "./config.js";
import { KokoroTTS } from "kokoro-js";

/** Truncate API error bodies to prevent leaking sensitive information in logs */
function truncateError(text: string, maxLen = 200): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

// Helper type for voice keys since it's not easily accessible
type KokoroVoice = keyof KokoroTTS["voices"];

export interface TTSResult {
  audioBuffer: Buffer;
  format: "pcm" | "opus" | "mp3";
  sampleRate: number;
}

export interface TTSProvider {
  synthesize(text: string): Promise<TTSResult>;
}

/** Valid OpenAI TTS voice names (ttsVoice may be from Kokoro/ElevenLabs config) */
const OPENAI_TTS_VOICES = ["nova", "shimmer", "echo", "onyx", "fable", "alloy", "ash", "sage", "coral"] as const;

function resolveOpenAIVoice(configured: string | undefined): string {
  const v = (configured || "nova").toLowerCase();
  return OPENAI_TTS_VOICES.includes(v as (typeof OPENAI_TTS_VOICES)[number]) ? v : "nova";
}

/**
 * OpenAI TTS Provider
 */
export class OpenAITTS implements TTSProvider {
  private apiKey: string;
  private model: string;
  private voice: string;

  constructor(config: DiscordVoiceConfig) {
    this.apiKey = config.openai?.apiKey || process.env["OPENAI_API_KEY"] || "";
    this.model = config.openai?.ttsModel || "tts-1";
    this.voice = resolveOpenAIVoice(config.openai?.voice);

    if (!this.apiKey) {
      throw new Error("OpenAI API key required for OpenAI TTS");
    }
  }

  async synthesize(text: string): Promise<TTSResult> {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice: this.voice,
        response_format: "opus", // Best for Discord voice
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI TTS error: ${response.status} ${truncateError(error)}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      audioBuffer: Buffer.from(arrayBuffer),
      format: "opus",
      sampleRate: 48000, // Opus from OpenAI is typically 48kHz
    };
  }
}

/**
 * ElevenLabs TTS Provider
 */
export class ElevenLabsTTS implements TTSProvider {
  private apiKey: string;
  private voiceId: string;
  private modelId: string;

  constructor(config: DiscordVoiceConfig) {
    this.apiKey = config.elevenlabs?.apiKey || process.env["ELEVENLABS_API_KEY"] || "";
    this.voiceId = validateElevenLabsVoiceId(config.elevenlabs?.voiceId || "21m00Tcm4TlvDq8ikWAM");
    this.modelId = config.elevenlabs?.modelId || "eleven_turbo_v2_5";

    if (!this.apiKey) {
      throw new Error("ElevenLabs API key required for ElevenLabs TTS");
    }
  }

  async synthesize(text: string): Promise<TTSResult> {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}`, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: this.modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ElevenLabs TTS error: ${response.status} ${truncateError(error)}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      audioBuffer: Buffer.from(arrayBuffer),
      format: "mp3",
      sampleRate: 44100,
    };
  }
}

// Shared instance to prevent loading the model multiple times (Singleton)
let sharedKokoroInstance: KokoroTTS | null = null;
let sharedInitPromise: Promise<void> | null = null;

/**
 * Kokoro TTS Provider (Local/Offline)
 */
export class KokoroTTSProvider implements TTSProvider {
  private modelId: string;
  private dtype: "fp32" | "fp16" | "q8" | "q4" | "q4f16";
  private voice: string;

  constructor(config: DiscordVoiceConfig) {
    this.modelId = validateKokoroModel(config.kokoro?.modelId || "onnx-community/Kokoro-82M-v1.0-ONNX");
    this.dtype = config.kokoro?.dtype || "fp32";
    this.voice = config.kokoro?.voice ?? "af_heart";
  }

  private async ensureInitialized() {
    if (sharedKokoroInstance) return;

    if (!sharedInitPromise) {
      sharedInitPromise = (async () => {
        try {
          console.log(`Loading Kokoro TTS model: ${this.modelId} (${this.dtype})...`);
          sharedKokoroInstance = await KokoroTTS.from_pretrained(this.modelId, {
            dtype: this.dtype,
            device: "cpu", // Node.js always uses CPU
          });
          console.log("Kokoro TTS model loaded.");
        } catch (error) {
          console.error("Failed to load Kokoro TTS model:", error);
          sharedInitPromise = null; // Reset promise to allow retries
          throw error;
        }
      })();
    }

    await sharedInitPromise;
  }

  async synthesize(text: string): Promise<TTSResult> {
    await this.ensureInitialized();

    if (!sharedKokoroInstance) {
      throw new Error("Kokoro TTS failed to initialize");
    }

    // Validate voice exists, fallback to default if not
    const requestedVoice = this.voice as KokoroVoice;
    const voice = requestedVoice in sharedKokoroInstance.voices ? requestedVoice : "af_heart";

    const audioObj = await sharedKokoroInstance.generate(text, {
      voice,
    });

    // Convert Float32Array to Int16 PCM Buffer
    const float32Array = audioObj.audio;
    const sampleRate = audioObj.sampling_rate;

    const buffer = Buffer.alloc(float32Array.length * 2);
    for (let i = 0; i < float32Array.length; i++) {
      // Clamp between -1 and 1
      const s = Math.max(-1, Math.min(1, float32Array[i]!));
      // Convert to 16-bit PCM
      const val = s < 0 ? s * 0x8000 : s * 0x7fff;
      buffer.writeInt16LE(Math.floor(val), i * 2);
    }

    return {
      audioBuffer: buffer,
      format: "pcm",
      sampleRate: sampleRate,
    };
  }
}

/**
 * Create TTS provider based on config
 */
export function createTTSProvider(config: DiscordVoiceConfig): TTSProvider {
  switch (config.ttsProvider) {
    case "elevenlabs":
      return new ElevenLabsTTS(config);
    case "kokoro":
      return new KokoroTTSProvider(config);
    case "openai":
    default:
      return new OpenAITTS(config);
  }
}
