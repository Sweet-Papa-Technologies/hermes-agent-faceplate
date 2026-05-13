// Receives unprompted/agent-initiated messages from the Hermes "faceplate"
// plugin (see hermes-plugin/README.md) over a local WebSocket. Decoded
// frames are forwarded to all renderer windows via IPC; from there a
// renderer-side handler injects them into the conversation store + fires
// an OS notification (Phase 4) and optional TTS.
//
// Why main-process instead of renderer:
//   - Single WS for the whole app (multiple renderer windows would each
//     open their own otherwise — duplicate frames + duplicate notifications)
//   - Reconnect/backoff lives in one place
//   - Auth token never crosses the contextBridge as a request param
//
// Reference: docs/v1/research/phase6-hermes-push.md

import { BrowserWindow, ipcMain } from 'electron';
import WebSocket from 'ws';

import { IPC, type AgentPushFrame, type AgentPushStatus } from './preload-api';
import { getSettings, onSettingsChanged } from './settings-store';

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_MS = 500;

let ws: WebSocket | null = null;
let reconnectDelay = RECONNECT_INITIAL_MS;
let reconnectTimer: NodeJS.Timeout | null = null;
let lastError: string | null = null;
let lastFrameAt: number | null = null;
let lastTargetUrl = '';
let stopped = false;

function broadcastFrame(frame: AgentPushFrame): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.agentPush.received, frame);
  }
}

function clearReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (stopped) return;
  clearReconnect();
  const jitter = Math.floor(Math.random() * RECONNECT_JITTER_MS);
  const wait = Math.min(reconnectDelay, RECONNECT_MAX_MS) + jitter;
  console.log(`[agent-push] reconnect in ${wait}ms`);
  reconnectTimer = setTimeout(() => connect(), wait);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function connect(): void {
  const cfg = getSettings().agent_push;
  if (!cfg.enabled) {
    teardown();
    return;
  }
  if (!cfg.api_key) {
    lastError = 'no api_key configured';
    return;
  }
  // Build URL with chat_id query param. Plugin uses '*' to mean "all".
  let url = cfg.url;
  try {
    const u = new URL(cfg.url);
    if (cfg.chat_id) u.searchParams.set('chat_id', cfg.chat_id);
    url = u.toString();
  } catch {
    lastError = `invalid agent_push.url: ${cfg.url}`;
    return;
  }
  lastTargetUrl = url;

  // Tear down any prior socket before opening a new one.
  if (ws) {
    try {
      ws.removeAllListeners();
      ws.terminate();
    } catch {
      /* noop */
    }
    ws = null;
  }

  console.log(`[agent-push] connecting to ${url}`);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.api_key}`,
  };
  let next: WebSocket;
  try {
    next = new WebSocket(url, { headers });
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn('[agent-push] WebSocket constructor threw:', lastError);
    scheduleReconnect();
    return;
  }
  ws = next;

  next.on('open', () => {
    console.log('[agent-push] connected');
    reconnectDelay = RECONNECT_INITIAL_MS;
    lastError = null;
  });

  next.on('message', (data: WebSocket.RawData) => {
    let frame: AgentPushFrame;
    try {
      frame = JSON.parse(data.toString()) as AgentPushFrame;
    } catch (err) {
      console.warn('[agent-push] non-JSON frame, dropping:', err);
      return;
    }
    if (frame.type === 'message') {
      lastFrameAt = Date.now();
    }
    broadcastFrame(frame);
  });

  next.on('close', (code, reason) => {
    console.log(`[agent-push] closed code=${code} reason=${reason.toString().slice(0, 120)}`);
    if (next === ws) ws = null;
    if (code === 4401 || code === 1008) {
      // Auth failure — don't loop forever bouncing the server.
      lastError = `unauthorized (close ${code})`;
      return;
    }
    scheduleReconnect();
  });

  next.on('error', (err) => {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn('[agent-push] socket error:', lastError);
    // 'error' is followed by 'close' which schedules the reconnect.
  });
}

function teardown(): void {
  clearReconnect();
  if (ws) {
    try {
      ws.removeAllListeners();
      ws.close();
    } catch {
      /* noop */
    }
    ws = null;
  }
}

export function startAgentPushBridge(): void {
  stopped = false;
  ipcMain.handle(IPC.agentPush.status, (): AgentPushStatus => ({
    enabled: getSettings().agent_push.enabled,
    connected: ws?.readyState === WebSocket.OPEN,
    url: lastTargetUrl || getSettings().agent_push.url,
    last_error: lastError,
    last_frame_at: lastFrameAt,
  }));

  // React to settings changes — toggle, URL, key, or chat_id all reset
  // the connection. Cheap to reconnect; the plugin's WS server is local.
  onSettingsChanged((_settings, keys) => {
    if (!keys.some((k) => k.startsWith('agent_push.'))) return;
    console.log('[agent-push] settings changed, reconnecting');
    reconnectDelay = RECONNECT_INITIAL_MS;
    teardown();
    connect();
  });

  if (getSettings().agent_push.enabled) connect();
}

export function stopAgentPushBridge(): void {
  stopped = true;
  teardown();
}
