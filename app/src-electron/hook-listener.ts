// Local HTTP listener that catches lifecycle payloads from hermes-agent's
// shell hooks and rebroadcasts them as FaceplateEvents.
//
// Per addendum #3, the bridge is observe-only — every response body is `{}`,
// no rewrite. Captures every agent turn regardless of channel (CLI,
// Telegram, cron, etc.).
//
// Listens on 127.0.0.1:51789 by default. If the port is taken, picks the
// next free port — the installer reads the chosen port at install time so
// the on-disk script always knows where to POST.

import { BrowserWindow } from 'electron';
import { createServer, type Server } from 'node:http';

import { IPC } from './preload-api';
import type {
  AgentToolCall,
  FaceplateEvent,
} from '../src/hermes/event-schema';

const DEFAULT_PORT = 51789;
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 256 * 1024;

let server: Server | null = null;
let activePort = 0;

export function isHookListenerRunning(): boolean {
  return server !== null;
}

export function hookListenerPort(): number {
  return activePort;
}

export async function startHookListener(): Promise<number> {
  if (server) return activePort;
  return new Promise((resolve, reject) => {
    const s = createServer((req, res) => {
      void handleRequest(req, res);
    });
    s.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Try a random ephemeral port. Listener is loopback-only so this is
        // safe; the installer will be told what port we ended up on.
        s.listen(0, HOST);
      } else {
        reject(err);
      }
    });
    s.on('listening', () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        activePort = addr.port;
        server = s;
        console.log(`[hook-listener] listening on ${HOST}:${activePort}`);
        resolve(activePort);
      }
    });
    s.listen(DEFAULT_PORT, HOST);
  });
}

export async function stopHookListener(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server!.close(() => {
      server = null;
      activePort = 0;
      resolve();
    });
  });
}

async function handleRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  // Always respond `{}` per addendum #3 — observe-only.
  const respond = () => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  };

  if (req.method !== 'POST') {
    respond();
    return;
  }
  if (!req.url || !req.url.startsWith('/hook/')) {
    respond();
    return;
  }
  const eventName = req.url.slice('/hook/'.length).split('?')[0] ?? '';

  try {
    const body = await readBody(req);
    let payload: Record<string, unknown> = {};
    try {
      payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    } catch {
      payload = {};
    }
    const fe = mapToFaceplateEvent(eventName, payload);
    if (fe) broadcast(fe);
  } catch (err) {
    console.warn('[hook-listener] handler error:', err);
  } finally {
    respond();
  }
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function broadcast(event: FaceplateEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.events.broadcast, event);
  }
}

// Translate hermes-agent's lifecycle event name + payload into our union.
//
// We support a handful of recognised events. Unknown events become
// `agent.thinking` with an empty payload so the renderer at least notes
// activity.
function mapToFaceplateEvent(
  eventName: string,
  payload: Record<string, unknown>,
): FaceplateEvent | null {
  const ts = Date.now();
  switch (eventName) {
    case 'on_session_start':
      return {
        type: 'state.transition',
        ts,
        payload: { from: 'idle', to: 'idle', reason: 'session.start' },
      };
    case 'on_session_end':
    case 'on_session_finalize':
      return {
        type: 'state.transition',
        ts,
        payload: { from: 'speaking', to: 'idle', reason: 'session.end' },
      };
    case 'on_session_reset':
      return {
        type: 'system.config_changed',
        ts,
        payload: { keys: ['hermes.session.reset'] },
      };
    case 'pre_llm_call':
      return {
        type: 'agent.thinking',
        ts,
        ...(typeof payload.tool === 'string' ? { payload: { tool: payload.tool } } : { payload: {} }),
      };
    case 'post_llm_call':
      return {
        type: 'agent.response',
        ts,
        payload: {
          text: typeof payload.text === 'string' ? payload.text : '',
          finished_reason: 'stop',
        },
      };
    case 'pre_tool_call':
      return {
        type: 'agent.tool_call',
        ts,
        payload: {
          tool: typeof payload.tool === 'string' ? payload.tool : 'tool',
          args_preview: typeof payload.args_preview === 'string' ? payload.args_preview : '',
          status: 'started' satisfies AgentToolCall['status'],
        },
      };
    case 'post_tool_call':
      return {
        type: 'agent.tool_call',
        ts,
        payload: {
          tool: typeof payload.tool === 'string' ? payload.tool : 'tool',
          args_preview: typeof payload.args_preview === 'string' ? payload.args_preview : '',
          status:
            payload.status === 'failed'
              ? 'failed'
              : ('completed' satisfies AgentToolCall['status']),
        },
      };
    case 'subagent_stop':
      return {
        type: 'agent.interrupt',
        ts,
        payload: { initiator: 'agent' },
      };
    default:
      return null;
  }
}
