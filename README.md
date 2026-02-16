# Discord Voice Plugin for OpenClaw

Real-time voice conversations in Discord voice channels. Join a voice channel, speak, and have your words transcribed, processed by Claude, and spoken back.

## Features

- **Join/Leave Voice Channels**: Via slash commands, CLI, or agent tool
- **Voice Activity Detection (VAD)**: Automatically detects when users are speaking
- **Speech-to-Text**: Whisper API (OpenAI), Deepgram, or Local Whisper (Offline)
- **Streaming STT**: Real-time transcription with Deepgram WebSocket (~1s latency reduction)
- **Agent Integration**: Transcribed speech is routed through the Clawdbot agent
- **Text-to-Speech**: OpenAI TTS, ElevenLabs, or Kokoro (Local/Offline)
- **Audio Playback**: Responses are spoken back in the voice channel
- **Barge-in Support**: Stops speaking immediately when user starts talking
- **Thinking Sound**: Optional looping sound while processing (configurable)
- **Auto-reconnect**: Automatic heartbeat monitoring and reconnection on disconnect

## Requirements

- Discord bot with voice permissions (Connect, Speak, Use Voice Activity)
- API keys for STT and TTS providers
- System dependencies for voice:
  - `ffmpeg` (audio processing)
  - Native build tools for `@discordjs/opus` and `sodium-native`

## Installation

### 1. Install System Dependencies

```bash
# Ubuntu/Debian
sudo apt-get install ffmpeg build-essential python3

# Fedora/RHEL
sudo dnf install ffmpeg gcc-c++ make python3

# macOS
brew install ffmpeg
```

### 2. Install Node Dependencies

```bash
# When installed as OpenClaw plugin
cd ~/.openclaw/extensions/discord-voice
npm install

# Or for development (link from OpenClaw workspace)
openclaw plugins install ./path/to/discord-voice
```

### 3. Configure in openclaw.json (or ~/.openclaw/openclaw.json)

```json5
{
  plugins: {
    entries: {
      "discord-voice": {
        enabled: true,
        config: {
          sttProvider: "whisper",
          ttsProvider: "openai",
          ttsVoice: "nova",
          vadSensitivity: "medium",
          allowedUsers: [], // Empty = allow all users
          silenceThresholdMs: 800,
          maxRecordingMs: 30000,
          openai: {
            apiKey: "sk-...", // Or use OPENAI_API_KEY env var
          },
        },
      },
    },
  },
}
```

**Complete example (Grok + ElevenLabs + GPT-4o-mini STT):**

```json5
{
  plugins: {
    entries: {
      "discord-voice": {
        enabled: true,
        config: {
          autoJoinChannel: "DISCORDCHANNELID",
          model: "xai/grok-4-1-fast-non-reasoning",
          thinkLevel: "off",
          sttProvider: "gpt4o-mini",
          ttsProvider: "elevenlabs",
          ttsVoice: "VOICEID",
          vadSensitivity: "medium",
          bargeIn: true,
          openai: { apiKey: "sk-proj-..." },
          elevenlabs: { apiKey: "sk_...", modelId: "turbo" },
        },
      },
    },
  },
}
```

Replace `DISCORDCHANNELID` with your Discord voice channel ID and `VOICEID` with your ElevenLabs voice ID.

### 4. Discord Bot Setup

Ensure your Discord bot has these permissions:

- **Connect** - Join voice channels
- **Speak** - Play audio
- **Use Voice Activity** - Detect when users speak

Add these to your bot's OAuth2 URL or configure in Discord Developer Portal.

## Configuration

| Option                | Type              | Default                               | Description                                                                                                                                                                             |
| --------------------- | ----------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | boolean           | `true`                                | Enable/disable the plugin                                                                                                                                                               |
| `sttProvider`         | string            | `"whisper"`                           | `"whisper"`, `"local-whisper"`, `"gpt4o-mini"`, `"gpt4o-transcribe"`, `"gpt4o-transcribe-diarize"` (OpenAI), or `"deepgram"`                                                            |
| `streamingSTT`        | boolean           | `true`                                | Use streaming STT (Deepgram only, ~1s faster)                                                                                                                                           |
| `ttsProvider`         | string            | `"openai"`                            | `"openai"`, `"elevenlabs"`, or `"kokoro"`                                                                                                                                               |
| `ttsVoice`            | string            | `"nova"`                              | Deprecated – use provider-specific: `openai.voice`, `elevenlabs.voiceId`, `kokoro.voice`                                                                                                |
| `vadSensitivity`      | string            | `"medium"`                            | `"low"`, `"medium"`, or `"high"`                                                                                                                                                        |
| `bargeIn`             | boolean           | `true`                                | Stop speaking when user talks                                                                                                                                                           |
| `allowedUsers`        | string[]          | `[]`                                  | User IDs allowed (empty = all)                                                                                                                                                          |
| `silenceThresholdMs`  | number            | `800`                                 | Silence before processing (ms); lower = snappier                                                                                                                                        |
| `maxRecordingMs`      | number            | `30000`                               | Max recording length (ms)                                                                                                                                                               |
| `heartbeatIntervalMs` | number            | `30000`                               | Connection health check interval                                                                                                                                                        |
| `autoJoinChannel`     | string            | `undefined`                           | Channel ID to auto-join on startup                                                                                                                                                      |
| `openclawRoot`        | string            | `undefined`                           | OpenClaw package root if auto-detection fails                                                                                                                                           |
| `thinkingSound`       | object            | see [Thinking Sound](#thinking-sound) | Sound played while processing                                                                                                                                                           |
| `noEmojiHint`         | boolean \| string | `true`                                | Inject TTS hint into agent prompt; when set, emojis are also stripped from responses before TTS (avoids Kokoro reading them aloud)                                                      |
| `ttsFallbackProvider` | string            | `undefined`                           | Fallback when primary fails (quota/rate limit): `"openai"`, `"elevenlabs"`, or `"kokoro"` (free, local). Once switched, the session stays on fallback until the bot leaves the channel. |

### Fallbacks from Main OpenClaw Config

When a plugin option is not set, the plugin uses values from the main OpenClaw config when available:

| Plugin option       | Fallback source(s)                                                            |
| ------------------- | ----------------------------------------------------------------------------- |
| `model`             | `agents.defaults.model.primary` or `agents.list[0].model`                     |
| `ttsProvider`       | `tts.provider`                                                                |
| `ttsVoice`          | `tts.voice`                                                                   |
| OpenAI `apiKey`     | `talk.apiKey`, `providers.openai.apiKey`, or `models.providers.openai.apiKey` |
| ElevenLabs `apiKey` | `plugins.entries.elevenlabs.config.apiKey`                                    |

The Discord bot token is always read from `channels.discord.token` (or `channels.discord.accounts.default.token`).

### Provider Configuration

#### OpenAI (STT + TTS)

```json5
{
  openai: {
    apiKey: "sk-...",
    whisperModel: "whisper-1", // or use sttProvider: "gpt4o-mini"
    ttsModel: "tts-1",
    voice: "nova", // nova, shimmer, echo, onyx, fable, alloy, ash, sage, coral (default: nova)
  },
}
```

OpenAI STT options: `whisper` (legacy), `gpt4o-mini` (faster, cheaper), `gpt4o-transcribe` (higher quality), `gpt4o-transcribe-diarize` (with speaker identification).

#### ElevenLabs (TTS only)

```json5
{
  elevenlabs: {
    apiKey: "...",
    voiceId: "21m00Tcm4TlvDq8ikWAM", // Rachel (ElevenLabs voice ID)
    modelId: "turbo", // turbo | flash | v2 | v3
  },
}
```

- `modelId: "turbo"` – eleven_turbo_v2_5 (default, fastest, lowest latency)
- `modelId: "flash"` – eleven_flash_v2_5 (fast)
- `modelId: "v2"` – eleven_multilingual_v2 (balanced)
- `modelId: "v3"` – eleven_multilingual_v3 (most expressive)

#### Deepgram (STT only)

```json5
{
  sttProvider: "deepgram",
  deepgram: {
    apiKey: "...",
    model: "nova-2",
  },
}
```

#### Local Whisper (STT only, offline)

No API key required. Runs locally using Xenova/Transformers.

```json5
{
  sttProvider: "local-whisper",
  localWhisper: {
    model: "Xenova/whisper-tiny.en", // Optional, default
    quantized: true, // Optional, smaller/faster
  },
}
```

#### Kokoro (Local TTS) – Free

No API key required. Runs locally on CPU. Use as primary or as `ttsFallbackProvider` when ElevenLabs/OpenAI hit quota limits. With `noEmojiHint` enabled (default), emojis are stripped from responses before TTS so Kokoro does not try to read them aloud.

```json5
{
  ttsProvider: "kokoro",
  kokoro: {
    voice: "af_heart", // af_heart, af_bella, af_nicole, etc. (default: af_heart)
    modelId: "onnx-community/Kokoro-82M-v1.0-ONNX", // Optional
    dtype: "fp32", // Optional: "fp32", "q8", "q4"
  },
}
```

#### TTS Fallback (quota / rate limit)

When the primary TTS fails with quota exceeded or rate limit, a fallback provider can be used. Once switched to fallback, the session stays on the fallback provider until the bot leaves the voice channel, avoiding repeated failures on each response.

```json5
{
  ttsProvider: "elevenlabs",
  ttsFallbackProvider: "kokoro", // Free local fallback when ElevenLabs quota is exceeded
  elevenlabs: { apiKey: "...", voiceId: "...", modelId: "turbo" },
}
```

## Usage

### Slash Commands (Discord)

Once registered with Discord, use these commands:

- `/voice join <channel>` - Join a voice channel
- `/voice leave` - Leave the current voice channel
- `/voice status` - Show voice connection status

### CLI Commands

```bash
# Join a voice channel
clawdbot voice join <channelId>

# Leave voice
clawdbot voice leave --guild <guildId>

# Check status
clawdbot voice status
```

### Agent Tool

The agent can use the `discord_voice` tool:

```
Join voice channel 1234567890
```

The tool supports actions:

- `join` - Join a voice channel (requires channelId)
- `leave` - Leave voice channel
- `speak` - Speak text in the voice channel
- `status` - Get current voice status

## How It Works

1. **Join**: Bot joins the specified voice channel
2. **Listen**: VAD detects when users start/stop speaking
3. **Record**: Audio is buffered while user speaks
4. **Transcribe**: On silence, audio is sent to STT provider
5. **Process**: Transcribed text is sent to Clawdbot agent
6. **Synthesize**: Agent response is converted to audio via TTS
7. **Play**: Audio is played back in the voice channel

## Streaming STT (Deepgram)

When using Deepgram as your STT provider, streaming mode is enabled by default. This provides:

- **~1 second faster** end-to-end latency
- **Real-time feedback** with interim transcription results
- **Automatic keep-alive** to prevent connection timeouts
- **Fallback** to batch transcription if streaming fails

To use streaming STT:

```json5
{
  sttProvider: "deepgram",
  streamingSTT: true, // default
  deepgram: {
    apiKey: "...",
    model: "nova-2",
  },
}
```

## Barge-in Support

When enabled (default), the bot will immediately stop speaking if a user starts talking. This creates a more natural conversational flow where you can interrupt the bot.

To disable (let the bot finish speaking):

```json5
{
  bargeIn: false,
}
```

## Thinking Sound

While the bot processes speech and generates a response, it can play a short looping sound. A default `thinking.mp3` is included in `assets/`. Configure via `thinkingSound`:

```json5
{
  thinkingSound: {
    enabled: true,
    path: "assets/thinking.mp3",
    volume: 0.7,
    stopDelayMs: 50,
  },
}
```

- `enabled`: `true` by default. Set to `false` to disable.
- `path`: Path to MP3 (relative to plugin root or absolute). Default `assets/thinking.mp3`.
- `volume`: 0–1, default `0.7`.
- `stopDelayMs`: Delay (ms) after stopping thinking sound before playing response. Default `50`. Range 0–500. Lower = snappier.

If the file is missing, no sound is played. Any short ambient or notification MP3 works (e.g. 2–5 seconds, looped).

## Auto-reconnect

The plugin includes automatic connection health monitoring:

- **Heartbeat checks** every 30 seconds (configurable)
- **Auto-reconnect** on disconnect with exponential backoff
- **Max 3 attempts** before giving up

If the connection drops, you'll see logs like:

```
[discord-voice] Disconnected from voice channel
[discord-voice] Reconnection attempt 1/3
[discord-voice] Reconnected successfully
```

## VAD Sensitivity

- **low**: Picks up quiet speech, may trigger on background noise
- **medium**: Balanced (recommended)
- **high**: Requires louder, clearer speech

## Troubleshooting

### "Unable to resolve OpenClaw root"

If you see this when processing voice input, set `openclawRoot` in your plugin config to the directory that contains `dist/extensionAPI.js`:

```json5
{
  plugins: {
    entries: {
      "discord-voice": {
        enabled: true,
        config: {
          openclawRoot: "/home/openclaw-user/.openclaw/extensions/discord-voice/node_modules/openclaw",
        },
      },
    },
  },
}
```

Example: if your `extensionAPI.js` is at `.../discord-voice/node_modules/openclaw/dist/extensionAPI.js`, use the `node_modules/openclaw` path (the directory containing `dist/`). Alternatively, set the `OPENCLAW_ROOT` environment variable.

### "Discord client not available"

Ensure the Discord channel is configured and the bot is connected before using voice.

### "Cannot find module structures/ClientUser" (discord.js)

This can happen with a corrupted or incomplete install. In the plugin directory, run:

```bash
cd ~/.openclaw/extensions/discord-voice
rm -rf node_modules package-lock.json
npm install
```

Then restart the gateway.

### Opus/Sodium build errors

Install build tools:

```bash
npm install -g node-gyp
npm rebuild @discordjs/opus sodium-native
```

### No audio heard

1. Check bot has Connect + Speak permissions
2. Check bot isn't server muted
3. Verify TTS API key is valid

### Transcription not working

1. Check STT API key is valid
2. Check audio is being recorded (see debug logs)
3. Try adjusting VAD sensitivity

### Enable debug logging

```bash
DEBUG=discord-voice clawdbot gateway start
```

## Environment Variables

| Variable             | Description                                     |
| -------------------- | ----------------------------------------------- |
| `OPENCLAW_ROOT`      | OpenClaw package root (if auto-detection fails) |
| `OPENAI_API_KEY`     | OpenAI API key (Whisper + TTS)                  |
| `ELEVENLABS_API_KEY` | ElevenLabs API key                              |
| `DEEPGRAM_API_KEY`   | Deepgram API key                                |

## Limitations

- Only one voice channel per guild at a time
- Maximum recording length: 30 seconds (configurable)
- Requires stable network for real-time audio
- TTS output may have slight delay due to synthesis

## OpenClaw Compatibility

This plugin targets **OpenClaw** (formerly Clawdbot). It uses the same core bridge pattern as the official voice-call plugin: it loads the agent API from OpenClaw's `dist/extensionAPI.js`. The plugin is discovered via `openclaw.extensions` in package.json and `openclaw.plugin.json`.

If auto-detection fails, set `openclawRoot` in the plugin config (see Troubleshooting) or `OPENCLAW_ROOT` to the directory containing `dist/extensionAPI.js` (e.g. `.../discord-voice/node_modules/openclaw`).

## License

MIT
