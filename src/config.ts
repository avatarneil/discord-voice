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
  sttProvider:
    | "whisper"
    | "gpt4o-mini"
    | "gpt4o-transcribe"
    | "gpt4o-transcribe-diarize"
    | "deepgram"
    | "local-whisper";
  streamingSTT: boolean; // Use streaming STT (Deepgram only) for lower latency
  ttsProvider: "openai" | "elevenlabs" | "kokoro";
  ttsVoice: string;
  /** Fallback TTS provider when primary fails (quota, rate limit). E.g. "kokoro" for free local fallback. */
  ttsFallbackProvider?: "openai" | "elevenlabs" | "kokoro";
  vadSensitivity: "low" | "medium" | "high";
  bargeIn: boolean; // Stop speaking when user starts talking
  allowedUsers: string[];
  silenceThresholdMs: number;
  minAudioMs: number;
  maxRecordingMs: number;
  autoJoinChannel?: string; // Channel ID to auto-join on startup
  heartbeatIntervalMs?: number; // Connection health check interval
  /** OpenClaw package root (if auto-detection fails); path to openclaw package dir containing dist/extensionAPI.js */
  openclawRoot?: string;

  /** Thinking sound played while processing; path relative to plugin root or absolute */
  thinkingSound?: {
    enabled?: boolean;
    path?: string; // default: "assets/thinking.mp3"
    volume?: number; // 0–1, default 0.7
    stopDelayMs?: number; // delay after stopping before response (default 50, was 100)
  };

  // LLM settings for voice responses (use fast models for low latency)
  model?: string; // e.g. "anthropic/claude-3-5-haiku-latest" or "openai/gpt-4o-mini"
  thinkLevel?: string; // "off", "low", "medium", "high" - lower = faster
  /**
   * Inject TTS-friendly hint into agent prompt.
   * - `true` (default): use default text ("do not use emojis…")
   * - `false`: do not inject
   * - `string`: use this custom text
   */
  noEmojiHint?: boolean | string;

  openai?: {
    apiKey?: string;
    whisperModel?: string;
    ttsModel?: string;
    /** OpenAI TTS voice: nova, shimmer, echo, onyx, fable, alloy, ash, sage, coral. Default: nova */
    voice?: string;
  };
  elevenlabs?: {
    apiKey?: string;
    voiceId?: string;
    /**
     * Model ID: eleven_turbo_v2_5 (default), eleven_flash_v2_5, eleven_multilingual_v2, eleven_multilingual_v3, etc.
     */
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
    /** Kokoro voice: af_heart, af_bella, af_nicole, etc. Default: af_heart */
    voice?: string;
  };
}

export const DEFAULT_CONFIG: DiscordVoiceConfig = {
  enabled: true,
  sttProvider: "whisper",
  streamingSTT: true, // Enable streaming by default when using Deepgram
  ttsProvider: "openai",
  ttsVoice: "nova",
  vadSensitivity: "medium",
  bargeIn: true, // Enable barge-in by default
  allowedUsers: [],
  silenceThresholdMs: 800, // 800ms - snappy response after speech ends
  minAudioMs: 300, // 300ms minimum - filter very short noise
  maxRecordingMs: 30000,
  heartbeatIntervalMs: 30000,
  // model: undefined - uses system default, recommend "anthropic/claude-3-5-haiku-latest" for speed
  // thinkLevel: undefined - defaults to "off" for voice (fastest)
};

/** Default text for noEmojiHint when true */
export const DEFAULT_NO_EMOJI_HINT = "Do not use emojis—your response will be read aloud by a TTS engine.";

/** ElevenLabs model shorthands → full model IDs */
export const ELEVENLABS_MODELS = {
  turbo: "eleven_turbo_v2_5",
  flash: "eleven_flash_v2_5",
  v2: "eleven_multilingual_v2",
  v3: "eleven_multilingual_v3",
} as const;

/** Resolve ElevenLabs model ID; supports shorthands turbo, flash, v2, v3 */
function resolveElevenLabsModelId(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const mapped = ELEVENLABS_MODELS[s as keyof typeof ELEVENLABS_MODELS];
  if (mapped) return mapped;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return "eleven_turbo_v2_5";
}

function getStr(obj: unknown, ...path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" && cur.trim() ? cur.trim() : undefined;
}

/**
 * Main OpenClaw config shape for fallback resolution.
 * See: agents.defaults.model, tts, talk, providers, plugins.entries
 */
export type MainConfig = Record<string, unknown>;

function resolveFromMain(main: MainConfig | undefined): {
  model?: string;
  ttsProvider?: "openai" | "elevenlabs";
  ttsVoice?: string;
  openaiApiKey?: string;
  elevenlabsApiKey?: string;
} {
  if (!main || typeof main !== "object") return {};

  const m = main as Record<string, unknown>;
  const modelObj = m["agents"] as Record<string, unknown> | undefined;
  const defaults = modelObj?.["defaults"] as Record<string, unknown> | undefined;
  const modelCfg = defaults?.["model"];
  const modelPrimary =
    typeof modelCfg === "string"
      ? modelCfg
      : modelCfg && typeof modelCfg === "object" && "primary" in modelCfg
        ? (modelCfg as { primary?: string }).primary
        : undefined;

  const list = modelObj?.["list"] as unknown[] | undefined;
  const firstAgentModel =
    Array.isArray(list) && list[0] && typeof list[0] === "object"
      ? (list[0] as Record<string, unknown>)["model"]
      : undefined;
  const agentModel =
    typeof firstAgentModel === "string"
      ? firstAgentModel
      : firstAgentModel && typeof firstAgentModel === "object" && "primary" in firstAgentModel
        ? (firstAgentModel as { primary?: string }).primary
        : undefined;

  const tts = m["tts"] as Record<string, unknown> | undefined;
  const ttsProviderRaw = tts?.["provider"];
  const ttsProvider =
    ttsProviderRaw === "elevenlabs"
      ? ("elevenlabs" as const)
      : ttsProviderRaw === "openai"
        ? ("openai" as const)
        : undefined;

  const talk = m["talk"] as Record<string, unknown> | undefined;
  const providers = m["providers"] as Record<string, unknown> | undefined;
  const openaiProvider = providers?.["openai"] as Record<string, unknown> | undefined;
  const openaiApiKey =
    getStr(talk, "apiKey") || getStr(openaiProvider, "apiKey") || getStr(m, "models", "providers", "openai", "apiKey");

  const plugins = m["plugins"] as Record<string, unknown> | undefined;
  const pluginsEntries = plugins?.["entries"] as Record<string, unknown> | undefined;
  const elevenlabsPlugin = pluginsEntries?.["elevenlabs"] as Record<string, unknown> | undefined;
  const elevenlabsConfig = elevenlabsPlugin?.["config"] as Record<string, unknown> | undefined;
  const elevenlabsApiKey = getStr(elevenlabsConfig, "apiKey");

  return {
    model: modelPrimary || agentModel,
    ttsProvider,
    ttsVoice: getStr(tts, "voice"),
    openaiApiKey,
    elevenlabsApiKey,
  };
}

export function parseConfig(raw: unknown, mainConfig?: MainConfig): DiscordVoiceConfig {
  const fallback = resolveFromMain(mainConfig);

  if (!raw || typeof raw !== "object") {
    return {
      ...DEFAULT_CONFIG,
      model: fallback.model,
      ttsProvider: fallback.ttsProvider ?? DEFAULT_CONFIG.ttsProvider,
      ttsVoice: fallback.ttsVoice ?? DEFAULT_CONFIG.ttsVoice,
      openai: fallback.openaiApiKey
        ? { apiKey: fallback.openaiApiKey, whisperModel: "whisper-1", ttsModel: "tts-1" }
        : undefined,
      elevenlabs: fallback.elevenlabsApiKey
        ? { apiKey: fallback.elevenlabsApiKey, modelId: resolveElevenLabsModelId(undefined) }
        : undefined,
      thinkingSound: { enabled: true, path: "assets/thinking.mp3", volume: 0.7 },
    } as DiscordVoiceConfig;
  }

  const obj = raw as Record<string, unknown>;

  const ttsProviderRaw =
    obj["ttsProvider"] === "elevenlabs"
      ? "elevenlabs"
      : obj["ttsProvider"] === "kokoro"
        ? "kokoro"
        : obj["ttsProvider"] === "openai"
          ? "openai"
          : null;

  const ttsVoiceVal = typeof obj["ttsVoice"] === "string" ? obj["ttsVoice"] : null;
  const ttsVoice = ttsVoiceVal ?? fallback.ttsVoice ?? DEFAULT_CONFIG.ttsVoice;

  const modelVal = typeof obj["model"] === "string" ? obj["model"] : null;
  const model = modelVal ?? fallback.model ?? undefined;

  return {
    enabled: typeof obj["enabled"] === "boolean" ? obj["enabled"] : DEFAULT_CONFIG.enabled,
    sttProvider:
      obj["sttProvider"] === "deepgram"
        ? "deepgram"
        : obj["sttProvider"] === "gpt4o-transcribe-diarize"
          ? "gpt4o-transcribe-diarize"
          : obj["sttProvider"] === "gpt4o-transcribe"
            ? "gpt4o-transcribe"
            : obj["sttProvider"] === "gpt4o-mini"
              ? "gpt4o-mini"
              : obj["sttProvider"] === "local-whisper"
                ? "local-whisper"
                : "whisper",
    streamingSTT: typeof obj["streamingSTT"] === "boolean" ? obj["streamingSTT"] : DEFAULT_CONFIG.streamingSTT,
    ttsProvider: (["openai", "elevenlabs", "kokoro"].includes(obj["ttsProvider"] as string)
      ? obj["ttsProvider"]
      : ttsProviderRaw) as "openai" | "elevenlabs" | "kokoro",
    ttsVoice,
    ttsFallbackProvider: (() => {
      const primary = (
        ["openai", "elevenlabs", "kokoro"].includes(obj["ttsProvider"] as string) ? obj["ttsProvider"] : ttsProviderRaw
      ) as "openai" | "elevenlabs" | "kokoro";
      const fb = obj["ttsFallbackProvider"];
      if (!["openai", "elevenlabs", "kokoro"].includes(fb as string)) return undefined;
      return fb === primary ? undefined : (fb as "openai" | "elevenlabs" | "kokoro");
    })(),
    vadSensitivity: ["low", "medium", "high"].includes(obj["vadSensitivity"] as string)
      ? (obj["vadSensitivity"] as "low" | "medium" | "high")
      : DEFAULT_CONFIG.vadSensitivity,
    bargeIn: typeof obj["bargeIn"] === "boolean" ? obj["bargeIn"] : DEFAULT_CONFIG.bargeIn,
    allowedUsers: Array.isArray(obj["allowedUsers"])
      ? (obj["allowedUsers"] as unknown[]).filter((u): u is string => typeof u === "string")
      : [],
    silenceThresholdMs: (() => {
      const v =
        typeof obj["silenceThresholdMs"] === "number" ? obj["silenceThresholdMs"] : DEFAULT_CONFIG.silenceThresholdMs;
      return v >= 0 ? v : DEFAULT_CONFIG.silenceThresholdMs;
    })(),
    minAudioMs: (() => {
      const v = typeof obj["minAudioMs"] === "number" ? obj["minAudioMs"] : DEFAULT_CONFIG.minAudioMs;
      return v >= 0 ? v : DEFAULT_CONFIG.minAudioMs;
    })(),
    maxRecordingMs: (() => {
      const v = typeof obj["maxRecordingMs"] === "number" ? obj["maxRecordingMs"] : DEFAULT_CONFIG.maxRecordingMs;
      return v >= 0 ? v : DEFAULT_CONFIG.maxRecordingMs;
    })(),
    autoJoinChannel:
      typeof obj["autoJoinChannel"] === "string" && obj["autoJoinChannel"].trim()
        ? obj["autoJoinChannel"].trim()
        : undefined,
    openclawRoot:
      typeof obj["openclawRoot"] === "string" && obj["openclawRoot"].trim() ? obj["openclawRoot"].trim() : undefined,
    heartbeatIntervalMs: (() => {
      const v =
        typeof obj["heartbeatIntervalMs"] === "number"
          ? obj["heartbeatIntervalMs"]
          : DEFAULT_CONFIG.heartbeatIntervalMs;
      const def = DEFAULT_CONFIG.heartbeatIntervalMs ?? 30_000;
      return typeof v === "number" && v >= 0 ? v : def;
    })(),
    model,
    thinkLevel: typeof obj["thinkLevel"] === "string" ? obj["thinkLevel"] : undefined,
    noEmojiHint: (() => {
      if (obj["noEmojiHint"] === false) return false;
      const s = obj["noEmojiHint"];
      if (typeof s === "string" && s.trim()) return s.trim();
      return true;
    })(),
    openai: (() => {
      const o = obj["openai"] && typeof obj["openai"] === "object" ? (obj["openai"] as Record<string, unknown>) : null;
      const apiKey = (o?.["apiKey"] as string | undefined) || fallback.openaiApiKey;
      if (!apiKey) return undefined;
      return {
        apiKey,
        whisperModel: (o?.["whisperModel"] as string) || "whisper-1",
        ttsModel: (o?.["ttsModel"] as string) || "tts-1",
        voice:
          typeof o?.["voice"] === "string" && (o["voice"] as string).trim() ? (o["voice"] as string).trim() : "nova",
      };
    })(),
    elevenlabs: (() => {
      const o =
        obj["elevenlabs"] && typeof obj["elevenlabs"] === "object"
          ? (obj["elevenlabs"] as Record<string, unknown>)
          : null;
      const apiKey = (o?.["apiKey"] as string | undefined) || fallback.elevenlabsApiKey;
      if (!apiKey) return undefined;
      return {
        apiKey,
        voiceId: o?.["voiceId"] as string | undefined,
        modelId: resolveElevenLabsModelId(o?.["modelId"]),
      };
    })(),
    deepgram:
      obj["deepgram"] && typeof obj["deepgram"] === "object"
        ? {
            apiKey: (obj["deepgram"] as Record<string, unknown>)["apiKey"] as string | undefined,
            model: ((obj["deepgram"] as Record<string, unknown>)["model"] as string) || "nova-2",
          }
        : undefined,
    localWhisper:
      obj["localWhisper"] && typeof obj["localWhisper"] === "object"
        ? {
            model: ((obj["localWhisper"] as Record<string, unknown>)["model"] as string) || "Xenova/whisper-tiny.en",
            quantized:
              typeof (obj["localWhisper"] as Record<string, unknown>)["quantized"] === "boolean"
                ? ((obj["localWhisper"] as Record<string, unknown>)["quantized"] as boolean)
                : true,
          }
        : undefined,
    kokoro:
      obj["kokoro"] && typeof obj["kokoro"] === "object"
        ? {
            modelId: (() => {
              const m = (obj["kokoro"] as Record<string, unknown>)["modelId"];
              return typeof m === "string" && m.trim() ? m.trim() : "onnx-community/Kokoro-82M-v1.0-ONNX";
            })(),
            dtype: (["fp32", "fp16", "q8", "q4", "q4f16"].includes(
              (obj["kokoro"] as Record<string, unknown>)["dtype"] as string,
            )
              ? (obj["kokoro"] as Record<string, unknown>)["dtype"]
              : "fp32") as "fp32" | "fp16" | "q8" | "q4" | "q4f16",
            voice:
              typeof (obj["kokoro"] as Record<string, unknown>)["voice"] === "string" &&
              (obj["kokoro"] as Record<string, unknown>)["voice"]
                ? String((obj["kokoro"] as Record<string, unknown>)["voice"]).trim()
                : "af_heart",
          }
        : undefined,
    thinkingSound: (() => {
      const t =
        obj["thinkingSound"] && typeof obj["thinkingSound"] === "object"
          ? (obj["thinkingSound"] as Record<string, unknown>)
          : null;
      if (!t) return { enabled: true, path: "assets/thinking.mp3", volume: 0.7, stopDelayMs: 50 };
      const enabled = "enabled" in t ? t["enabled"] !== false : true;
      const path =
        typeof t["path"] === "string" && (t["path"] as string).trim()
          ? (t["path"] as string).trim()
          : "assets/thinking.mp3";
      let volume = 0.7;
      if (typeof t["volume"] === "number" && t["volume"] >= 0 && t["volume"] <= 1) volume = t["volume"];
      let stopDelayMs = 50;
      if (typeof t["stopDelayMs"] === "number" && t["stopDelayMs"] >= 0 && t["stopDelayMs"] <= 500)
        stopDelayMs = t["stopDelayMs"];
      return { enabled, path, volume, stopDelayMs };
    })(),
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
