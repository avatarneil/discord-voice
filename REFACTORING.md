# Refactoring Plan: Discord Voice Plugin

> Initialisiert für strukturiertes Refactoring am 13.02.2025

## Projektübersicht

**discord-voice** ist ein Clawdbot-Plugin für Echtzeit-Sprachunterhaltungen in Discord-Voice-Channels:
- VAD (Voice Activity Detection), STT (Whisper/Deepgram), TTS (OpenAI/ElevenLabs)
- Streaming STT/TTS, Barge-in, Auto-Reconnect, Heartbeat-Monitoring

---

## Codebase-Analyse

### Dateistruktur & LOC (ca.)

| Datei | LOC | Rolle |
|-------|-----|-------|
| `index.ts` | ~430 | Plugin-Entry, Gateway, Tool, CLI, `handleTranscript` |
| `src/voice-connection.ts` | ~680 | VoiceManager: Join/Leave, Recording, Playback, Heartbeat |
| `src/stt.ts` | ~170 | Batch STT (Whisper, Deepgram) |
| `src/tts.ts` | ~130 | Batch TTS (OpenAI, ElevenLabs) |
| `src/streaming-stt.ts` | ~390 | Deepgram Streaming STT + Manager |
| `src/streaming-tts.ts` | ~225 | Streaming TTS (OpenAI, ElevenLabs) |
| `src/config.ts` | ~145 | Config-Parsing, VAD-Thresholds |
| `src/core-bridge.ts` | ~195 | Dynamischer Import zu Clawdbot Core |

**Gesamt:** ~2.400 LOC

---

## Identifizierte Probleme

### 1. Monolithische Dateien

- **index.ts**: Gateway-Handler, Tool-Logik, CLI, Discord-Client, `handleTranscript`, Session-Setup – alles in einer Datei
- **voice-connection.ts**: Recording, Playback, Heartbeat, Reconnect, Thinking-Sound, RMS-Berechnung – zu viele Verantwortlichkeiten

### 2. Code-Duplikation

- **Session/Guild-Resolving** wiederholt in Gateway-Methoden und Tool:
  ```ts
  // 4x ähnlich: wenn kein guildId → sessions[0].guildId
  if (!guildId) {
    const sessions = vm.getAllSessions();
    guildId = sessions[0]?.guildId;
  }
  ```
- **Channel-Validierung** in Gateway und Tool identisch
- **getRmsThreshold** in `voice-connection.ts` vs. **getVadThreshold** in `config.ts` (ähnliche Semantik, unterschiedliche Werte)

### 3. Magic Numbers & Konstanten

- `SPEAK_COOLDOWN_MS`: 800 (VAD-Ignore) vs. 500 (Processing-Skip)
- `minAudioMs`, `silenceThresholdMs` – Defaults teils in config, teils hardcoded
- Kein zentraler Ort für Cooldown/Threshold-Werte

### 4. Dead Code

- `playThinkingSoundSimple()` in `voice-connection.ts` wird nie aufgerufen (nur `startThinkingLoop` genutzt)

### 5. Logging-Inkonsistenz

- `streaming-stt.ts`: `console.log` / `console.error` statt Logger
- `index.ts` CLI: `console.log` / `console.error` (CLI-Kontext, aber ohne einheitliches Format)
- `api.logger` wird nicht überall durchgereicht

### 6. Typen & Casts

- Mehrfach `as VoiceBasedChannel`, `as { guildId?: string }`, etc.
- `any` in CLI: `const prog = program as any`
- Fehlende shared Types für Gateway-Params / Tool-Params

### 7. Fehlende Infrastruktur

- Keine Tests
- Kein ESLint/Prettier
- Kein `npm run typecheck` (nur implizit über IDE/tsc)
- `assets/thinking.mp3` referenziert, aber nicht im Repo

### 8. Abhängigkeiten & Schnittstellen

- `core-bridge.ts` importiert aus `dist/` – Plugin benötigt gebautes Clawdbot
- `PluginApi`-Interface nur lokal in `index.ts` definiert

---

## Refactoring-Backlog (priorisiert)

### Phase 1: Grundlagen (schnelle Wins) ✅

1. [x] **Konstanten zentralisieren** – `src/constants.ts` für Cooldowns, Thresholds
2. [x] **Dead Code entfernen** – `playThinkingSoundSimple` löschen
3. [x] **Logging vereinheitlichen** – Logger in `StreamingSTTManager` injizieren, `console.*` ersetzen
4. [x] **Typecheck-Script** – `npm run typecheck` in `package.json`
5. [x] **Assets dokumentieren** – README/Config für `assets/thinking.mp3`

### Phase 2: Modularisierung

6. [ ] **index.ts aufteilen**:
   - `src/plugin/register.ts` – Plugin-Registration
   - `src/plugin/gateway.ts` – Gateway-Methoden
   - `src/plugin/tool.ts` – Agent-Tool
   - `src/plugin/cli.ts` – CLI-Commands
   - `src/plugin/transcript-handler.ts` – `handleTranscript` + Session-Logik
7. [ ] **voice-connection.ts aufteilen**:
   - `src/voice/connection-manager.ts` – Join/Leave, Sessions
   - `src/voice/recording.ts` – UserAudioState, startRecording, processRecording
   - `src/voice/playback.ts` – speak, stopSpeaking, thinking-loop
   - `src/voice/heartbeat.ts` – Heartbeat + Reconnect-Logik
8. [ ] **Gemeinsame Helpers** – `resolveGuildFromSessions`, `validateVoiceChannel` in `src/utils/`

### Phase 3: Robustheit & Tests

9. [ ] **ESLint + Prettier** – Konfiguration für Projekt
10. [ ] **Shared Types** – `types.ts` für Gateway-Params, Tool-Params, PluginApi
11. [ ] **Unit-Tests** – mind. für config, stt, tts (ohne Netzwerk)
12. [ ] **Integration-Tests** (optional) – mit Mocks für Discord/APIs

### Phase 4: Optional

13. [ ] **Provider-Factory** – einheitliche Factory für STT/TTS (inkl. Streaming)
14. [ ] **Dependency Injection** – Logger, Config als explizite Abhängigkeiten
15. [ ] **Docs** – JSDoc/TSDoc für öffentliche APIs

---

## Schnellbefehle

```bash
# Typecheck (vor/nach Refactoring)
npm run typecheck
```

---

## Nächste Schritte

1. Phase-1-Tasks abarbeiten (1–5)
2. Danach Phase 2 in kleinen, rückwärtskompatiblen Schritten
3. Vor größeren Änderungen: `npm run typecheck` sicherstellen
