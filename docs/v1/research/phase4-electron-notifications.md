# Phase 4 — Electron Notification API Research

> Research brief produced 2026-05-12 to inform Phase 4 of `v1.todo.md` (push notifications + AI auto-fix). Future sessions implementing notifications should re-read this.

## 1. API surface
Electron exposes two paths: the main-process `Notification` class from `electron`, and the renderer-side HTML5 `new Notification()`. The official tutorial recommends the **main-process `Notification` module** for any non-trivial app — it gives you full event callbacks (`show`, `click`, `close`, `reply`, `action`, `failed`), TypeScript types, and works with `Notification.isSupported()` for capability detection. The renderer API is convenient but has a thinner event surface and no access to `actions`/`hasReply`. Recommended pattern: renderer fires an IPC message → main process constructs and `.show()`s the `Notification`. ([Notifications tutorial](https://www.electronjs.org/docs/latest/tutorial/notifications), [Notification API](https://www.electronjs.org/docs/latest/api/notification))

## 2. Permissions model
- **macOS:** No explicit permission API in Electron; the OS prompts on first delivery and the user manages it under System Settings → Notifications. Optionally set `NSUserNotificationAlertStyle` (`banner` or `alert`) in `Info.plist` to influence default style. In production, the app **must be code-signed and notarized** or notifications are unreliable.
- **Windows 10/11:** Requires a Start Menu shortcut with an AppUserModelID. Squirrel sets this in production; in dev you must call `app.setAppUserModelId(process.execPath)` early in main, or notifications silently fail.
- **Linux:** Uses `libnotify` over the freedesktop Desktop Notifications spec. Works on GNOME, KDE, Cinnamon, Unity, Enlightenment. `actions` support varies (GNOME ignores them by default in many configs); `hasReply` is unsupported.

## 3. Click-to-focus
Attach a `click` handler on the `Notification` instance in main and call `BrowserWindow.show()` + `.focus()` (and `.restore()` if minimized). On Windows there's a known issue (#4766) where `focus()` alone doesn't always raise the window — the safe pattern is `win.show(); win.focus();` and on Win32 sometimes `win.setAlwaysOnTop(true); win.setAlwaysOnTop(false);` to force foreground.

```js
const n = new Notification({ title, body })
n.on('click', () => { avatarWin.show(); avatarWin.focus() })
n.show()
```

## 4. Behavior when foregrounded
Electron does **not** auto-suppress when the app is focused; you must gate it yourself. Use `app.on('browser-window-focus' / 'browser-window-blur')` to maintain a `isAppActive` flag rather than polling `BrowserWindow.isFocused()` per call (issue #20464 documents `isFocused()` returning stale `true` on Windows for hidden windows). Combine with a "captions panel visible" renderer-state flag passed over IPC.

## 5. Sound + interactivity
- `silent: true` suppresses OS sound (all platforms).
- `sound: 'Ping'` (string) plays a named macOS system sound — macOS only.
- `actions: [{ type: 'button', text: 'Reply' }]` — macOS + Windows; Linux is best-effort.
- `hasReply: true` + `replyPlaceholder` — macOS only; emits `reply` with the user's typed text. Useful for Phase 6 quick-reply UX.
- `urgency: 'low' | 'normal' | 'critical'` — Linux + Windows.
- `timeoutType: 'never'` — Linux + Windows; macOS notifications follow OS rules.

## 6. Quirks / gotchas
- **Windows AppUserModelID:** without `app.setAppUserModelId()` in dev, notifications silently no-op.
- **macOS notarization:** unsigned/un-notarized builds may show but won't persist in Notification Center reliably; ship signed.
- **Linux `appName`:** the launcher's `.desktop` file `Name=` must match `app.setName()` for the icon to appear correctly.
- **Dedup:** Electron has no built-in dedup — keep a `Map<id, Notification>` in main and `.close()` stale ones.
- **Quit cleanup:** notifications can outlive the app on macOS; call `.close()` on each tracked notification in `before-quit`.
- **`hasReply` + `actions` together:** historical bug (PR #37381) where reply obscured first action — fine on current Electron 42.

## 7. Recommended architecture for Faceplate
- Create notifications **in main**; renderer never touches the Web Notification API.
- IPC channel: `faceplate:notify:show` (renderer→main, payload `{ id, title, body, kind: 'response-complete' | 'agent-initiated', sound? }`); reverse `faceplate:notify:clicked` and `faceplate:notify:replied` (main→renderer).
- Call `app.setAppUserModelId('com.hermesagent.faceplate')` once in main before any window creation.
- Suppress when: `appActiveFlag === true` AND captions panel is visible AND user hasn't enabled "always notify"; also respect DND hours.
- Click handler: `agent-initiated` focuses Avatar window; `response-complete` focuses Conversations window if open, else Avatar.
- Track notifications in a `Map` keyed by conversation/turn id; `.close()` superseded ones.
- User settings: `notifications.enabled`, `notifications.sound`, `notifications.mode` (`always` | `backgrounded-only`), `notifications.dndStart/End`, `notifications.replyInline` (macOS only).
- Use `Notification.isSupported()` at startup; gracefully degrade to in-app toast if false.
- Phase 6 agent-initiated: enable `hasReply` on macOS to let users reply directly from the notification, routed back via `faceplate:notify:replied`.

## Sources
- [Electron Notifications tutorial](https://www.electronjs.org/docs/latest/tutorial/notifications)
- [Electron Notification API reference](https://www.electronjs.org/docs/latest/api/notification)
- [Electron app module (setAppUserModelId)](https://www.electronjs.org/docs/latest/api/app)
- [Electron Code Signing guide](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Issue #4766 — notification click focus on Windows](https://github.com/electron/electron/issues/4766)
- [Issue #20464 — `isFocused()` reliability on Windows](https://github.com/electron/electron/issues/20464)
- [PR #37381 — reply + actions ordering fix on macOS](https://github.com/electron/electron/pull/37381)
- [Proper Windows Notifications on Electron (dev.to)](https://dev.to/randomengy/proper-windows-notifications-on-electron-38jo)
