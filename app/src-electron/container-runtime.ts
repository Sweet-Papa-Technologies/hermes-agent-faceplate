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
}

/** Resolve the container engine binary.
 *
 *  M1: defaults to `docker` so behavior is unchanged for every existing
 *  user. Override with `FACEPLATE_CONTAINER_ENGINE=podman` for the spike
 *  and tests. M2 replaces this with podman-first auto-detection plus a
 *  persisted Settings value; M5 flips the default. */
export function containerEngine(): string {
  const override = process.env.FACEPLATE_CONTAINER_ENGINE?.trim();
  return override && override.length > 0 ? override : 'docker';
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
    proc.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    proc.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
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

let runtimeReady = false;

/** The gate every container lifecycle call funnels through.
 *
 *  - engine !== podman (docker / M1 default): **no-op** — guarantees
 *    zero behavior change for existing Docker users.
 *  - Linux + podman: no-op (rootless Podman is native, no VM).
 *  - macOS/Windows + podman: ensure the `podman machine` VM exists and is
 *    running (delegated to podman-machine.ts; dynamic import avoids a
 *    static import cycle). Cached after the first success so status polls
 *    don't re-shell every time. */
export async function ensureRuntime(): Promise<void> {
  if (containerEngine() !== 'podman') return;
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  if (runtimeReady) return;
  const { ensureMachine } = await import('./podman-machine');
  await ensureMachine();
  runtimeReady = true;
}

/** Drop the cached "machine is up" flag (e.g. after an explicit stop). */
export function invalidateRuntimeReady(): void {
  runtimeReady = false;
}
