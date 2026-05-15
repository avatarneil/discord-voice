# Voice: DAVE recovery + docs cleanup

## Summary

- **DAVE receive recovery:** When incoming audio fails with `DecryptionFailed(UnencryptedWhenPassthroughDisabled)`, the plugin automatically rejoins the channel once to establish a fresh DAVE session (same approach as [openclaw#25909](https://github.com/openclaw/openclaw/pull/25909)). This allows the next speech to be decrypted correctly.
- **Session channel ref:** Store `channel` on the voice session so the recovery rejoin can use the same channel without a separate lookup.
- **Docs:** Shortened troubleshooting section and translated to English. Document that voice typically reaches Ready only with @discordjs/voice 0.19.x and DAVE enabled; document the DAVE receive error and the automatic rejoin.

## Changes

- `src/voice-connection.ts`: `VoiceSession.channel`, `daveRecoveryScheduled`; `isDaveDecryptionError()`; `scheduleRejoinForDaveRecovery()`; on `AudioReceiveStream` error, call recovery when error is DAVE decryption; clear/reset flags in `attemptReconnect`; set `session.channel` on join and after reconnect.
- `README.md`: Replaced long voice troubleshooting checklist and German text with a short English section (0.19.x + DAVE, single client, voiceDebug, UDP, Carbon refs). Short DAVE receive subsection (auto-rejoin, links to openclaw#25909, #23105, discordjs/voice).

## Testing

- Join voice with DAVE enabled; when another user speaks, if decryption fails the bot logs "DAVE receive decryption failed — rejoining channel..." and rejoins once. Next speech can then be received successfully.
