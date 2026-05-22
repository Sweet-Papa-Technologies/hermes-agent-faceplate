// Single chokepoint for the container engine.
//
// Before M1 this logic was duplicated three times — `runDocker` in
// kokoro-lifecycle.ts and agent-push-installer.ts, `runCompose` in
// sidecar.ts — each hard-coded to the `docker` binary. This module
// consolidates the spawn/timeout/capture plumbing and resolves the engine
// name in one place so `docker` → `podman` becomes a one-line swap later.
//
// M1 INVARIANT — ZERO BEHAVIOR CHANGE: the engine still defaults to
// `docker`. The only new capability is that it's resolved through
// `containerEngine()` and overridable via the FACEPLATE_CONTAINER_ENGINE
// env var (used by the M0 spike / tests). Podman auto-detection + a
// Settings selector are M2 — deliberately NOT here.
//
// The runners reproduce the *exact* prior semantics:
//   - per-call timeouts are explicit at every call site (the old default
//     timeouts were never relied on except agent-push's `ps`, which now
//     passes 15 000 explicitly), and a runner with no `timeoutMs` never
//     times out — matching the old compose runner, which had no timer;
//   - `env`, when given, is merged over `process.env` exactly as the old
//     sidecar compose runner did.
//
// M0 spike finding 4d (docs/v1/podman-migration-plan.md): a broken
// ~/.docker/config.json credsStore breaks anonymous pulls. The mitigation
// hook lives here as `cleanRegistryAuthEnv()` but is intentionally NOT
// applied on the default path — wiring it in is an M2/M3 step, so docker
// behavior stays byte-identical in M1.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { getSettings, applyPatch } from './settings-store';

export interface EngineRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOpts {
  /** Hard timeout in ms. Omit for no timeout (matches the old compose
   *  runner, which never timed out). */
  timeoutMs?: number;
  /** Extra env vars, merged over `process.env` for the child process. */
  env?: Record<string, string>;
  /** Live output sink. Receives raw stdout+stderr chunks as they arrive
   *  (in addition to the buffered EngineRun). Used to surface real
   *  `podman pull`/`build`/`machine init` progress. Callers are
   *  responsible for throttling before forwarding to the renderer. */
  onOutput?: (chunk: string) => void;
}

/** Resolve the container engine binary. Sync + cheap (hot path).
 *
 *  Precedence: FACEPLATE_CONTAINER_ENGINE env override → persisted
 *  `infra.container_engine` setting (when pinned to docker/podman) →
 *  `docker` as the safe sync fallback while the setting is still 'auto'.
 *
 *  The M5 "default flips to Podman" happens via `resolveAndPersistEngine()`
 *  at startup: it turns 'auto' into a pinned 'podman'/'docker' value that
 *  this function then returns. The docker fallback here only applies in the
 *  brief pre-resolution window, so an existing Docker user is never broken.
 */
export function containerEngine(): string {
  const override = process.env.FACEPLATE_CONTAINER_ENGINE?.trim();
  if (override && override.length > 0) return override;
  // Local require avoids a load-order issue: container-runtime is imported
  // very early; settings-store is safe to read lazily here.
  const sel = getSettings().infra.container_engine;
  if (sel === 'docker' || sel === 'podman') return sel;
  return 'docker';
}

/** Startup engine resolution (M5). When the setting is 'auto', pick an
 *  engine and persist it so `containerEngine()` is stable thereafter:
 *
 *   - Podman installed AND no Docker-managed Hermes currently running →
 *     'podman' (the recommended default).
 *   - Otherwise, if Docker is available → 'docker' (never yank a running
 *     Docker setup; Decision #1 — existing users are offered, not forced).
 *   - Neither available → leave 'auto' (UI guides a Podman install;
 *     `containerEngine()` keeps returning the docker fallback).
 *
 *  No-op when the env override is set or the user has pinned an engine. */
export async function resolveAndPersistEngine(): Promise<void> {
  if (process.env.FACEPLATE_CONTAINER_ENGINE?.trim()) return;
  const sel = getSettings().infra.container_engine;
  if (sel === 'docker' || sel === 'podman') return;

  const podmanOk = await binaryWorks('podman');
  if (podmanOk) {
    const dockerHermesRunning = await dockerManagedHermesRunning();
    if (!dockerHermesRunning) {
      applyPatch({ infra: { container_engine: 'podman' } });
      return;
    }
    applyPatch({ infra: { container_engine: 'docker' } });
    return;
  }
  if (await binaryWorks('docker')) {
    applyPatch({ infra: { container_engine: 'docker' } });
  }
  // else: leave 'auto' — nothing installed yet.
}

async function binaryWorks(bin: string): Promise<boolean> {
  try {
    const r = await runTool(bin, ['--version'], { timeoutMs: 5_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

/** Is a Docker-managed Hermes container currently running? Used only by
 *  the startup resolver to avoid migrating a user off a working Docker
 *  setup behind their back. */
async function dockerManagedHermesRunning(): Promise<boolean> {
  try {
    const r = await runTool(
      'docker',
      ['ps', '--filter', 'name=hermes-personal', '--format', '{{.Names}}'],
      { timeoutMs: 8_000 },
    );
    return r.code === 0 && r.stdout.split(/\r?\n/).some((l) => l.trim() === 'hermes-personal');
  } catch {
    return false;
  }
}

function spawnEngine(
  binary: string,
  args: string[],
  opts: RunOpts,
): Promise<EngineRun> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(binary, args, {
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              proc.kill('SIGKILL');
            } catch {
              /* noop */
            }
            reject(new Error(`${binary} ${args[0]} timed out after ${opts.timeoutMs}ms`));
          }, opts.timeoutMs)
        : null;
    const emit = (s: string): void => {
      if (!opts.onOutput) return;
      try {
        opts.onOutput(s);
      } catch {
        /* a throwing sink must never break the run */
      }
    };
    proc.stdout.on('data', (b: Buffer) => {
      const s = b.toString('utf8');
      stdout += s;
      emit(s);
    });
    proc.stderr.on('data', (b: Buffer) => {
      const s = b.toString('utf8');
      stderr += s;
      emit(s);
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Merge the M0-4d clean-auth env in for Podman only. Docker keeps its
 *  exact M1 env (no REGISTRY_AUTH_FILE) so its behavior is byte-identical;
 *  Podman gets isolated from a broken ~/.docker/config.json credsStore so
 *  anonymous public pulls work. The auth file is written once per process. */
function withEngineEnv(engine: string, opts: RunOpts): RunOpts {
  if (engine !== 'podman') return opts;
  return { ...opts, env: { ...podmanRegistryEnv(), ...(opts.env ?? {}) } };
}

/** Run `<engine> <args>`. */
export function runEngine(args: string[], opts: RunOpts = {}): Promise<EngineRun> {
  const engine = containerEngine();
  return spawnEngine(engine, args, withEngineEnv(engine, opts));
}

/** Run `<engine> compose -f <file> <args>`. */
export function runEngineCompose(
  args: string[],
  composeFile: string,
  opts: RunOpts = {},
): Promise<EngineRun> {
  const engine = containerEngine();
  return spawnEngine(
    engine,
    ['compose', '-f', composeFile, ...args],
    withEngineEnv(engine, opts),
  );
}

/** Run an arbitrary tool (e.g. `podman machine …`). Engine-agnostic and
 *  does NOT inject auth env — used by podman-machine.ts for VM lifecycle. */
export function runTool(
  binary: string,
  args: string[],
  opts: RunOpts = {},
): Promise<EngineRun> {
  return spawnEngine(binary, args, opts);
}

/** `<engine> --version` exits 0. Default 5 s timeout matches the old
 *  `dockerAvailable()` in kokoro-lifecycle.ts. */
export async function engineAvailable(timeoutMs = 5_000): Promise<boolean> {
  try {
    const r = await runEngine(['--version'], { timeoutMs });
    return r.code === 0;
  } catch {
    return false;
  }
}

/** M0 finding 4d hook (NOT used on the M1 default path).
 *
 *  Podman/Docker read ~/.docker/config.json; a `credsStore`/`credHelpers`
 *  entry (gcloud, ECR, Docker-Desktop "desktop", …) makes even anonymous
 *  pulls of *public* images fail with a credential-helper error. For
 *  anonymous registry ops, point REGISTRY_AUTH_FILE at a clean `{}` file.
 *  All Faceplate-managed images are public, so this is always safe to use
 *  for pulls. M2/M3 will pass the result into `runEngine`'s `env`. */
export function cleanRegistryAuthEnv(): Record<string, string> {
  const authFile = path.join(os.tmpdir(), `faceplate-registry-auth-${process.pid}.json`);
  writeFileSync(authFile, '{}\n', 'utf8');
  return { REGISTRY_AUTH_FILE: authFile };
}

let memoPodmanAuthEnv: Record<string, string> | null = null;
/** Memoized `cleanRegistryAuthEnv()` — one temp file per process. */
function podmanRegistryEnv(): Record<string, string> {
  if (!memoPodmanAuthEnv) memoPodmanAuthEnv = cleanRegistryAuthEnv();
  return memoPodmanAuthEnv;
}

let runtimeReadyAt = 0;

/** The gate every container lifecycle call funnels through.
 *
 *  - engine !== podman (docker / M1 default): **no-op** — guarantees
 *    zero behavior change for existing Docker users.
 *  - Linux + podman: no-op (rootless Podman is native, no VM).
 *  - macOS/Windows + podman: ensure the `podman machine` VM exists, is
 *    running, AND is actually reachable (delegated to podman-machine.ts).
 *
 *  Caching is a short TTL, not a permanent flag: a permanent flag let a
 *  VM that died after first success (laptop sleep) stay invisible, so the
 *  next `podman run` failed with "ssh: handshake failed: EOF". The TTL
 *  bounds that staleness — within ~15 s a dead VM is re-detected and
 *  `ensureMachine` self-heals it. */
const RUNTIME_READY_TTL_MS = 15_000;

export async function ensureRuntime(onOutput?: (chunk: string) => void): Promise<void> {
  if (containerEngine() !== 'podman') return;
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  if (Date.now() - runtimeReadyAt < RUNTIME_READY_TTL_MS) return;
  const { ensureMachine } = await import('./podman-machine');
  await ensureMachine(onOutput);
  runtimeReadyAt = Date.now();
}

/** Drop the cached "machine is up" timestamp (e.g. after an explicit
 *  stop) so the next `ensureRuntime()` re-verifies immediately. */
export function invalidateRuntimeReady(): void {
  runtimeReadyAt = 0;
}
