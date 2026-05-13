# Phase 0 Research Reports

Background research produced 2026-05-12 to inform later phases of `../v1.todo.md`. Each report is self-contained; read the relevant one before starting that phase.

| Phase | Report | Topic |
|---|---|---|
| 3 | [phase3-kokoro-tts.md](phase3-kokoro-tts.md) | Kokoro TTS — runtime, latency, OpenAI-compat surface, swap design |
| 4 | [phase4-electron-notifications.md](phase4-electron-notifications.md) | Electron Notification API — main-process pattern, OS quirks, click-to-focus |
| 5 | [phase5-installer.md](phase5-installer.md) | Cross-platform curl/PowerShell installer + Electron distribution |
| 6 | [phase6-hermes-push.md](phase6-hermes-push.md) | HermesAgent unprompted-message surface — plugin platform adapter approach |

## Top-line conclusions

- **Phase 3 — Kokoro:** ghcr.io/remsky/kokoro-fastapi-cpu, drop-in `/v1/audio/speech`. Add `speech.tts.engine: 'piper' \| 'kokoro'` setting, swap `baseUrl` + voice list. ~340 MB extra disk, 17–22× realtime on Apple Silicon CoreML.
- **Phase 4 — Notifications:** main-process `Notification` + IPC (never the renderer Web API). `app.setAppUserModelId('com.hermesagent.faceplate')` in main before any window. Suppress when foregrounded via `browser-window-focus`/`-blur`. macOS-only `hasReply` enables Phase 6 quick-reply UX.
- **Phase 5 — Installer:** two URLs (`install.sh` POSIX, `install.ps1` Windows), prefix `~/.hermes/`, ship a packaged Electron via electron-builder, electron-updater for upgrades. Apple Developer ID + notarization + Azure Trusted Signing required for trust-free first launch.
- **Phase 6 — Unprompted messages:** no first-party `/v1/inbox` exists. Build a `~/.hermes/plugins/faceplate/` plugin platform adapter (aiohttp WebSocket); Hermes' cron + autonomous `send_message_tool` + webhook all route through us via the standard `send()` method. Conversation linkage = our conversation UUID as `chat_id`.
