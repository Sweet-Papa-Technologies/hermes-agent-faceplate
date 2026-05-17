// Faceplate main-process entry. Boots a tray-only app with one avatar window
// (overlay or windowed per settings) and an on-demand settings window.

import { app, session, shell } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyPatch, getSettings, registerSettingsIpc } from './settings-store';
import {
  DEFAULT_PARAPHRASE_PROMPT,
  PARAPHRASE_PROMPT_LEGACY_DEFAULTS,
} from '../src/stores/settings-schema';
import { readApiServerKey } from './hermes-discovery';
import {
  createAvatarWindow,
  createWizardWindow,
  isWayland,
  registerWindowIpc,
} from './window';
import {
  registerAllFromSettings,
  registerHotkeysIpc,
  unregisterAll,
} from './shortcuts';
import { createTray, destroyTray, hideDockOnMacOs, rebuildMenu } from './tray';
import { registerThemesIpc } from './themes-store';
import { registerHermesDiscoveryIpc } from './hermes-discovery';
import { registerHermesTesterIpc } from './hermes-tester';
import { registerParaphraseIpc } from './paraphrase-bridge';
import { registerSidecarIpc } from './sidecar';
import { registerHookIpc } from './hook-installer';
import { startHookListener, stopHookListener } from './hook-listener';
import { registerEventBridgeIpc } from './event-bridge';
import { registerPlatformIpc } from './platform-bridge';
import { registerNotificationsIpc } from './notifications-bridge';
import { registerArtifactFixIpc } from './artifact-fix-bridge';
import { startAgentPushBridge, stopAgentPushBridge } from './agent-push-bridge';
import { registerAgentPushInstallerIpc } from './agent-push-installer';
import { registerKokoroIpc } from './kokoro-lifecycle';
import {
  ensureBootstrapConversation,
  registerConversationsIpc,
} from './conversation-store';
import { registerArtifactsIpc } from './artifact-store';
import { ensureCanvasSkillInstalled } from './canvas-skill-installer';

// One-shot migration: if the user's paraphrase.system_prompt matches a
// literal previous default, upgrade to the current default AND reset the
// numeric knobs (trigger_chars, target_words) to the current defaults too.
// Rationale: a matching legacy prompt is a strong signal the user has never
// touched paraphrase settings; bumping the prompt without bumping the
// numbers leaves them on stale "speak more" defaults that defeat the
// shorter-summary intent. Customized prompts → no match → no change.
function migrateParaphrasePrompt(): void {
  const current = getSettings().paraphrase.system_prompt;
  if (current === DEFAULT_PARAPHRASE_PROMPT) return;
  if (!PARAPHRASE_PROMPT_LEGACY_DEFAULTS.includes(current)) return;
  // Defaults from settings-schema. Hard-coded here to keep the migration
  // self-contained — if the schema defaults change, bump these too.
  const NEW_TRIGGER_CHARS = 140;
  const NEW_TARGET_WORDS = 15;
  applyPatch({
    paraphrase: {
      system_prompt: DEFAULT_PARAPHRASE_PROMPT,
      trigger_chars: NEW_TRIGGER_CHARS,
      target_words: NEW_TARGET_WORDS,
    },
  });
  console.log(
    `[main] migrated paraphrase: system_prompt → new default, ` +
    `trigger_chars=${NEW_TRIGGER_CHARS}, target_words=${NEW_TARGET_WORDS}`,
  );
}

// One-shot migration: bump existing users off `local_litert` → `reuse_hermes_llm`
// since the LiteRT option is hidden in v1 (the bundled Gemma-4-E2B is too
// small to follow the summarize prompt reliably). The schema enum still
// accepts 'local_litert' so power users can opt in by editing settings.yaml,
// but the default + UI option is gone. Leave 'disabled' alone — that's an
// explicit user choice.
function migrateParaphraseModelAwayFromLitert(): void {
  const current = getSettings().paraphrase.model;
  if (current !== 'local_litert') return;
  applyPatch({ paraphrase: { model: 'reuse_hermes_llm' } });
  console.log("[main] migrated paraphrase.model: local_litert → reuse_hermes_llm");
}

// One-shot: seed `hermes.api_key` from ~/.hermes/.env when empty. The wizard
// asks the user to paste the key by hand; if they skipped that field but
// the local hermes config is readable, we already have it. Without this,
// chat-client POSTs to /v1/chat/completions with no Authorization header
// and hermes-agent rejects → red-shake error in the avatar.
function seedHermesApiKeyFromLocalEnv(): void {
  if (getSettings().hermes.api_key) return;
  const key = readApiServerKey();
  if (!key) return;
  applyPatch({ hermes: { api_key: key } });
  console.log('[main] seeded hermes.api_key from ~/.hermes/.env');
}

// One-shot: seed `speech.sidecar_token` from `sidecar/.faceplate-api-key`
// (the file `make setup` writes) when the user hasn't set one yet. Without
// this the wizard's TTS / ASR tests 401 even though everything is wired up
// correctly — and the user is told to copy the value into Settings by hand,
// which they tend not to do until something fails.
function seedSidecarTokenFromMakefileCache(): void {
  if (getSettings().speech.sidecar_token) return;
  const candidates = [
    // Prod (asar): app.getAppPath() → .../resources/app.asar; key file ships outside.
    path.resolve(app.getAppPath(), '..', '..', 'sidecar', '.faceplate-api-key'),
    // Dev: quasar dev cwd is repo/app, key file at ../sidecar/.faceplate-api-key.
    path.resolve(process.cwd(), '..', 'sidecar', '.faceplate-api-key'),
    // Run-from-repo-root or symlinked layouts.
    path.resolve(process.cwd(), 'sidecar', '.faceplate-api-key'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const token = readFileSync(p, 'utf8').trim();
      if (!token) continue;
      applyPatch({ speech: { sidecar_token: token } });
      console.log(`[main] seeded speech.sidecar_token from ${p}`);
      return;
    } catch (err) {
      console.warn(`[main] couldn't read ${p}:`, err);
    }
  }
}

// Hermes-agent's API server, the Faceplate sidecar, and litert-lm don't
// emit CORS response headers — they assume same-origin clients (curl, the
// hermes CLI, etc.). The Faceplate's renderer runs at http://localhost:9300
// in dev / file:// in prod, so a browser would block every fetch on
// preflight. Since this is a desktop app talking to its own local services,
// we inject permissive CORS headers in main for those specific upstreams.
// We do NOT touch responses from arbitrary URLs — the allowlist is the
// three host:ports configured in settings, plus their loopback aliases.
function installCorsHeaderInjection(): void {
  const allowedHosts = (): Set<string> => {
    const s = getSettings();
    const hosts = new Set<string>();
    for (const url of [
      s.hermes.base_url,
      s.speech.sidecar_url,
      s.paraphrase.litert_lm_url,
    ]) {
      try {
        const u = new URL(url);
        hosts.add(u.host); // host:port — matches webRequest URL parsing
      } catch {
        /* ignore malformed user input */
      }
    }
    return hosts;
  };

  const sess = session.defaultSession;

  // 0) Strip browser-injected `Origin` / `Sec-Fetch-*` / `Referer` headers
  //    on outgoing requests to allowed upstreams. hermes-agent's API server
  //    treats any request with an Origin header that doesn't match its own
  //    host as cross-site CSRF and returns 403 — even with a valid bearer
  //    token. curl works because it doesn't send Origin. We mimic that.
  sess.webRequest.onBeforeSendHeaders((details, callback) => {
    let host = '';
    try {
      host = new URL(details.url).host;
    } catch {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    if (!allowedHosts().has(host)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    const requestHeaders: Record<string, string> = { ...details.requestHeaders };
    for (const k of Object.keys(requestHeaders)) {
      const lower = k.toLowerCase();
      if (lower === 'origin' || lower === 'referer' || lower.startsWith('sec-fetch-')) {
        delete requestHeaders[k];
      }
    }
    callback({ requestHeaders });
  });

  // 1) Inject Allow-* on every response from an allowed upstream so the
  //    browser accepts the actual request (and the preflight, if upstream
  //    happens to return 200 OK on OPTIONS).
  sess.webRequest.onHeadersReceived((details, callback) => {
    let host = '';
    try {
      host = new URL(details.url).host;
    } catch {
      callback({});
      return;
    }
    if (!allowedHosts().has(host)) {
      callback({});
      return;
    }
    const responseHeaders: Record<string, string[]> = { ...(details.responseHeaders ?? {}) };
    // Reflect the request's Origin if present (more compatible with
    // Allow-Credentials than '*'). Falls back to '*' for null origins.
    // dev origin is http://localhost:9300, prod is file:// which sends
    // Origin: null.
    const origin = (details as unknown as { initiator?: string }).initiator || '*';
    responseHeaders['Access-Control-Allow-Origin'] = [origin === 'null' ? '*' : origin];
    responseHeaders['Access-Control-Allow-Credentials'] = ['true'];
    responseHeaders['Access-Control-Allow-Methods'] = ['GET, POST, PUT, PATCH, DELETE, OPTIONS'];
    responseHeaders['Access-Control-Allow-Headers'] = ['*, Authorization, Content-Type'];
    responseHeaders['Access-Control-Expose-Headers'] = ['*'];
    responseHeaders['Access-Control-Max-Age'] = ['86400'];
    // For preflight, also force a 200 in case upstream returned 405.
    let statusLine = details.statusLine;
    if (details.method === 'OPTIONS' && details.statusCode >= 400) {
      statusLine = 'HTTP/1.1 200 OK';
    }
    callback({ responseHeaders, statusLine });
  });
}

// Linux/Wayland: if the user has explicitly opted into "Force X11", the switch
// must be set BEFORE app.whenReady(). Settings are read synchronously here.
function applyEarlyPlatformFlags(): void {
  if (process.platform === 'linux' && isWayland()) {
    if (getSettings().linux.force_x11) {
      app.commandLine.appendSwitch('ozone-platform', 'x11');
    }
  }
}

const platform = process.platform || os.platform();

applyEarlyPlatformFlags();

// Windows: must be set BEFORE any window is created or notifications fire,
// otherwise OS notifications silently no-op (per Electron docs + research
// brief docs/v1/research/phase4-electron-notifications.md). Squirrel sets
// this in production; in dev we set it manually here. Match the value
// across both `app.setName` and `setAppUserModelId` so Linux desktop file
// `Name=` lookups also resolve correctly.
app.setName('HermesAgent Faceplate');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.hermesagent.faceplate');
}

void app.whenReady().then(() => {
  registerSettingsIpc();
  registerWindowIpc();
  registerHotkeysIpc();
  registerThemesIpc();
  registerHermesDiscoveryIpc();
  registerHermesTesterIpc();
  registerParaphraseIpc();
  registerSidecarIpc();
  registerHookIpc();
  registerEventBridgeIpc();
  registerPlatformIpc();
  registerNotificationsIpc();
  registerConversationsIpc();
  registerArtifactsIpc();
  registerArtifactFixIpc();
  startAgentPushBridge();
  registerAgentPushInstallerIpc();
  registerKokoroIpc();

  // Catch every webContents (avatar, canvas, settings, …) and route any
  // attempt to open a new window — `target="_blank"`, `window.open()`, or
  // a top-frame navigation to an external URL — to the system browser
  // instead of spawning an in-app BrowserWindow. Belt + suspenders to the
  // delegated <a href> click handler in CanvasPage.vue.
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const parsed = new URL(url);
        if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
          void shell.openExternal(parsed.toString());
        }
      } catch {
        // Malformed URL — drop silently.
      }
      return { action: 'deny' };
    });
  });

  // Make sure there's an active conversation on disk so the renderer always
  // has somewhere to land. Creates a fresh empty one on first run.
  ensureBootstrapConversation();

  // Auto-install the Hermes-side skill that teaches the model the inline
  // <artifact> output protocol. Idempotent + version-gated so user edits
  // don't get clobbered. Silent no-op if ~/.hermes doesn't exist yet.
  ensureCanvasSkillInstalled();

  migrateParaphrasePrompt();
  migrateParaphraseModelAwayFromLitert();
  seedHermesApiKeyFromLocalEnv();
  seedSidecarTokenFromMakefileCache();
  installCorsHeaderInjection();

  // Auto-start the hook listener when the user has previously installed
  // the bridge (settings.hermes.install_shell_hook). Without this, the
  // on-disk hook script POSTs into the void after a Faceplate restart.
  if (getSettings().hermes.install_shell_hook) {
    startHookListener().catch((err) =>
      console.error('[main] hook listener failed to start:', err),
    );
  }

  // First-run side effect: on Wayland with no explicit user override,
  // promote mode to 'windowed' (addendum #2). One-shot — once the user picks,
  // we respect it.
  const s = getSettings();
  if (
    process.platform === 'linux' &&
    isWayland() &&
    s.avatar.mode === 'overlay' &&
    !s.linux.force_x11
  ) {
    applyPatch({ avatar: { mode: 'windowed' } });
  }

  hideDockOnMacOs();
  createTray();
  createAvatarWindow();
  registerAllFromSettings();
  rebuildMenu();

  // First-run wizard. The avatar window is still created so users see the
  // overlay immediately; the wizard sits above it on first launch and
  // applyPatch updates flow through to the live overlay as the user picks.
  if (!getSettings().wizard.completed) {
    createWizardWindow();
  }
});

app.on('window-all-closed', () => {
  // Tray-only on macOS — keep the app alive when both windows are closed.
  if (platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  createAvatarWindow();
});

app.on('will-quit', () => {
  unregisterAll();
  destroyTray();
  void stopHookListener();
  stopAgentPushBridge();
});
