/**
 * Discord Voice Plugin Configuration
 */

// Placeholder for core TTS config compatibility
export interface VoiceCallTtsConfig {
  enabled?: boolean;
  voice?: string;
  [key: string]: unknown;
}

export interface DiscordVoiceConfig {
  enabled: boolean;
  sttProvider: "whisper" | "deepgram" | "local-whisper";
  streamingSTT: boolean; // Use streaming STT (Deepgram only) for lower latency
  ttsProvider: "openai" | "elevenlabs" | "kokoro";
  ttsVoice: string;
  vadSensitivity: "low" | "medium" | "high";
  bargeIn: boolean; // Stop speaking when user starts talking
  allowedUsers: string[];
  silenceThresholdMs: number;
  minAudioMs: number;
  maxRecordingMs: number;
  autoJoinChannel?: string; // Channel ID to auto-join on startup
  heartbeatIntervalMs?: number; // Connection health check interval

  // LLM settings for voice responses (use fast models for low latency)
  model?: string; // e.g. "anthropic/claude-3-5-haiku-latest" or "openai/gpt-4o-mini"
  thinkLevel?: string; // "off", "low", "medium", "high" - lower = faster

  openai?: {
    apiKey?: string;
    whisperModel?: string;
    ttsModel?: string;
  };
  elevenlabs?: {
    apiKey?: string;
    voiceId?: string;
    modelId?: string;
  };
  deepgram?: {
    apiKey?: string;
    model?: string;
  };
  localWhisper?: {
    model?: string; // e.g., "Xenova/whisper-tiny.en"
    quantized?: boolean;
  };
  kokoro?: {
    modelId?: string;
    dtype?: "fp32" | "fp16" | "q8" | "q4" | "q4f16";
  };
}

export const DEFAULT_CONFIG: DiscordVoiceConfig = {
  enabled: true,
  sttProvider: "local-whisper",
  streamingSTT: true, // Enable streaming by default when using Deepgram
  ttsProvider: "openai",
  ttsVoice: "nova",
  vadSensitivity: "medium",
  bargeIn: true, // Enable barge-in by default
  allowedUsers: [],
  silenceThresholdMs: 1000, // 1 second - faster response after speech ends
  minAudioMs: 300, // 300ms minimum - filter very short noise
  maxRecordingMs: 30000,
  heartbeatIntervalMs: 30000,
  // model: undefined - uses system default, recommend "anthropic/claude-3-5-haiku-latest" for speed
  // thinkLevel: undefined - defaults to "off" for voice (fastest)
};

export function parseConfig(raw: unknown): DiscordVoiceConfig {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_CONFIG;
  }

  const obj = raw as Record<string, unknown>;

  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_CONFIG.enabled,
    sttProvider: ["whisper", "deepgram", "local-whisper"].includes(obj.sttProvider as string)
      ? (obj.sttProvider as "whisper" | "deepgram" | "local-whisper")
      : DEFAULT_CONFIG.sttProvider,
    streamingSTT: typeof obj.streamingSTT === "boolean" ? obj.streamingSTT : DEFAULT_CONFIG.streamingSTT,
    ttsProvider: ["openai", "elevenlabs", "kokoro"].includes(obj.ttsProvider as string)
      ? (obj.ttsProvider as "openai" | "elevenlabs" | "kokoro")
      : "openai",
    ttsVoice: typeof obj.ttsVoice === "string" ? obj.ttsVoice : DEFAULT_CONFIG.ttsVoice,
    vadSensitivity: ["low", "medium", "high"].includes(obj.vadSensitivity as string)
      ? (obj.vadSensitivity as "low" | "medium" | "high")
      : DEFAULT_CONFIG.vadSensitivity,
    bargeIn: typeof obj.bargeIn === "boolean" ? obj.bargeIn : DEFAULT_CONFIG.bargeIn,
    allowedUsers: Array.isArray(obj.allowedUsers)
      ? obj.allowedUsers.filter((u): u is string => typeof u === "string")
      : [],
    silenceThresholdMs:
      typeof obj.silenceThresholdMs === "number" ? obj.silenceThresholdMs : DEFAULT_CONFIG.silenceThresholdMs,
    minAudioMs: typeof obj.minAudioMs === "number" ? obj.minAudioMs : DEFAULT_CONFIG.minAudioMs,
    maxRecordingMs: typeof obj.maxRecordingMs === "number" ? obj.maxRecordingMs : DEFAULT_CONFIG.maxRecordingMs,
    autoJoinChannel:
      typeof obj.autoJoinChannel === "string" && obj.autoJoinChannel.trim() ? obj.autoJoinChannel.trim() : undefined,
    heartbeatIntervalMs:
      typeof obj.heartbeatIntervalMs === "number" ? obj.heartbeatIntervalMs : DEFAULT_CONFIG.heartbeatIntervalMs,
    model: typeof obj.model === "string" ? obj.model : undefined,
    thinkLevel: typeof obj.thinkLevel === "string" ? obj.thinkLevel : undefined,
    openai:
      obj.openai && typeof obj.openai === "object"
        ? {
            apiKey: (obj.openai as Record<string, unknown>).apiKey as string | undefined,
            whisperModel: ((obj.openai as Record<string, unknown>).whisperModel as string) || "whisper-1",
            ttsModel: ((obj.openai as Record<string, unknown>).ttsModel as string) || "tts-1",
          }
        : undefined,
    elevenlabs:
      obj.elevenlabs && typeof obj.elevenlabs === "object"
        ? {
            apiKey: (obj.elevenlabs as Record<string, unknown>).apiKey as string | undefined,
            voiceId: (obj.elevenlabs as Record<string, unknown>).voiceId as string | undefined,
            modelId: ((obj.elevenlabs as Record<string, unknown>).modelId as string) || "eleven_multilingual_v2",
          }
        : undefined,
    deepgram:
      obj.deepgram && typeof obj.deepgram === "object"
        ? {
            apiKey: (obj.deepgram as Record<string, unknown>).apiKey as string | undefined,
            model: ((obj.deepgram as Record<string, unknown>).model as string) || "nova-2",
          }
        : undefined,
    localWhisper:
      obj.localWhisper && typeof obj.localWhisper === "object"
        ? {
            model: ((obj.localWhisper as Record<string, unknown>).model as string) || "Xenova/whisper-tiny.en",
            quantized:
              typeof (obj.localWhisper as Record<string, unknown>).quantized === "boolean"
                ? ((obj.localWhisper as Record<string, unknown>).quantized as boolean)
                : true,
          }
        : undefined,
    kokoro:
      obj.kokoro && typeof obj.kokoro === "object"
        ? {
            modelId:
              ((obj.kokoro as Record<string, unknown>).modelId as string) || "onnx-community/Kokoro-82M-v1.0-ONNX",
            dtype: ["fp32", "fp16", "q8", "q4", "q4f16"].includes(
              (obj.kokoro as Record<string, unknown>).dtype as string,
            )
              ? ((obj.kokoro as Record<string, unknown>).dtype as "fp32" | "fp16" | "q8" | "q4" | "q4f16")
              : "fp32",
          }
        : undefined,
  };
}

/**
 * Get VAD threshold based on sensitivity setting
 */
export function getVadThreshold(sensitivity: "low" | "medium" | "high"): number {
  switch (sensitivity) {
    case "low":
      return 0.01; // Very sensitive - picks up quiet speech
    case "high":
      return 0.05; // Less sensitive - requires louder speech
    case "medium":
    default:
      return 0.02;
  }
}
