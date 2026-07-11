# Docker → Podman Migration Plan

> ⚠ **SUPERSEDED — kept for historical reference.**
>
> This plan was executed end-to-end (M0–M6) on 2026-05-17. It was then
> **retired** by the audience pivot captured in
> [`rescope.md`](./rescope.md): the Faceplate is now a thin client and
> does not install, install Podman, or manage a `podman machine`. The
> `container-runtime.ts` / `podman-installer.ts` / `podman-machine.ts` /
> `hermes-lifecycle.ts` modules described below were all deleted in M2 of
> the re-scope. A "consumer edition" that ships an app-managed runtime
> could revive this plan from git history; the current product does not.
>
> Read this only for the M0 spike findings (rootless volume ownership,
> `host.docker.internal` aliasing on Podman 5.x, the `credsStore` gotcha)
> — those facts about Podman itself remain accurate.

Status: **proposed — for review, no code written yet**
Author: planning pass, 2026-05-17

## Decisions locked (from product review)

1. **Podman is the default, app-managed runtime. Docker stays permanently
   supported as an opt-in** for users who already have it or prefer it. The
   runtime abstraction is therefore a permanent feature, not a temporary
   shim — `container-runtime.ts` + an engine selector in Settings (Podman =
   default/recommended/auto-installed; Docker = "I already use Docker").
2. **App-managed Podman.** The app detects/installs Podman, manages
   `podman machine` on macOS/Windows, and owns the Hermes Agent container
   lifecycle from a one-click GUI action.
3. **Sidecars stay containerized** (speech / Kokoro / SearXNG) — moved to
   Podman now; native-bundle is explicitly deferred to a later milestone, not
   in this scope.
4. **Hermes Agent runs sandboxed in a container** (rootless Podman by
   default, or the user's Docker) — this is a security boundary, not just
   packaging. **We never install or facilitate bare-metal Hermes.** The only
   bare-metal case we support is *connecting to a Hermes the user already
   runs themselves* (bare metal or their own container) via the existing
   URL+key settings / discovery — see §6. If they have no Hermes, the app
   installs it via Podman; there is no bare-metal install path.

## Why Podman (recap of the rationale)

- The autonomous agent (browser tool, unprompted cron, autonomous decisions)
  needs a sandbox on personal/work machines. Container = real blast-radius
  reduction the user can't configure themselves.
- Podman is **rootless + daemonless** (a security *win* vs Docker's root
  daemon), **free** (no Docker Desktop org licensing), and
  **package-manager installable** (`brew` / `winget` / `choco` / `apt`),
  which is exactly the accessible one-click story we want.
- Podman's CLI is ~drop-in for `docker run/ps/restart/build/pull/inspect`,
  so this is an abstraction layer + new lifecycle modules, not a rewrite.

---

## M0 results — SPIKE COMPLETE, ALL GATES PASS (validated 2026-05-17)

Run on this machine: macOS arm64, host user `uid=501(fterry) gid=20(staff)`,
Podman 5.8.2 (Homebrew), `podman machine` 4 CPU / 4096 MB. Real `~/.hermes`
never touched — all ownership tests used a throwaway `~/.hermes-podman-spike`
(since deleted).

- **4a (the make-or-break) — SOLVED.** The Hermes image runs as
  `hermes` **uid/gid 10000** and its entrypoint is *already built for
  rootless Podman* (comments literally cite "fakeroot in rootless Podman"
  and "macOS GID 20 'staff'"). Proven recipe:
  **`podman run --userns=keep-id:uid=10000,gid=10000 -v ~/.hermes:/opt/data …`**
  Result: container **read** a pre-seeded `0640` `config.yaml`, **wrote**
  new files, **appended** to `.env`; and every file the container created
  (the whole Hermes tree — `cron/`, `skills/`, `sessions/`, `SOUL.md`, …)
  landed on the **host owned by `501:20`**. Perfect coherence. No
  `HERMES_UID`/`HERMES_GID` env needed on the Podman path. *Open Q #2 is
  now closed positively.*
- **(a) rootless build — PASS.** `podman build scripts/hermes/Dockerfile`
  succeeds rootless in ~18 s (layer cache); Chromium 148 + `agent-browser`
  present, `AGENT_BROWSER_EXECUTABLE_PATH` set.
- **(c) host networking — PASS, better than expected.** Podman 5.x
  **natively** resolves `host.docker.internal` (aliased to
  `host.containers.internal` → `192.168.127.254`) **with no `--add-host`
  flag at all**, and a container reached a **macOS-host `127.0.0.1`-bound**
  listener through it. ⇒ The socat tunnel + SearXNG + hermes
  `model.base_url` configs that already use `host.docker.internal` work on
  Podman **with zero config changes**. We'll still pass
  `--add-host=host.docker.internal:host-gateway` defensively for older
  Podman, but §4b churn is now ~nil.
- **(d) sizing — works; disk is the watch-item.** 4 CPU / 4 GB ran build
  + containers fine. **But the images are huge: base 5.55 GB, browser
  image 6.13 GB; the VM consumed ~14 GB of host disk** and free space went
  24 GB → 12 GB. Installer **must** preflight free space (recommend
  **≥ 20 GB**) and surface a clear message; this is a real UX/footprint
  concern, not a blocker.
- **NEW finding — docker credsStore poisons anonymous pulls.** Podman
  reads `~/.docker/config.json`; this machine's `"credsStore": "desktop"`
  + gcloud `credHelpers` made even *public* `pull`/`run` fail with a
  gcloud reauth error. Mitigation (must be in `container-runtime.ts`): set
  `REGISTRY_AUTH_FILE` to a clean `{}` file for anonymous registry ops and
  use `--pull=never` on `run`. Add as item **4d**.

**Verdict: the plan is technically validated. M0's gate is cleared — M1
can proceed.** Leftover artifacts on disk: the `podman machine` + the two
~6 GB images (reusable for M1+; tear-down decision noted to the user).

---

## 1. Surface inventory — everything that touches `docker` today

| Surface | Calls | Disposition |
|---|---|---|
| `scripts/start-hermes.sh` | `pull`, `build`, `run`, `ps`, `rm`, `image inspect` | Logic ports into a TS lifecycle module (canonical for the app); script stays for CLI/Make with `ENGINE` param |
| `scripts/start-searxng.sh` | searxng compose | Engine-param; compose strategy = Open Question #5 |
| `scripts/start-llm-tunnel.sh` | relies on `host.docker.internal` from container | Fixed via `--add-host` on the Hermes run (see §4) |
| `app/src-electron/agent-push-installer.ts` | `ps -a`, `restart` | Use abstraction; replace `ps` heuristic with the now-known container name |
| `app/src-electron/kokoro-lifecycle.ts` | `--version`, `inspect`, `run`, `start`, `stop` | Refactor onto abstraction |
| `app/src-electron/sidecar.ts` | `compose up/down` | Convert to `podman run` (mirrors Kokoro pattern) — M4 |
| `Makefile` | many `docker` / `docker compose` targets, `check-prereqs` | `ENGINE ?= podman`; swap targets |
| `sidecar/compose.*.yml`, `searxng/docker-compose.yml` | compose specs | Convert sidecar to `podman run` (M4); searxng = Open Q #5 |
| `scripts/hermes/Dockerfile`, `sidecar/Dockerfile.*` | OCI Dockerfiles | **Unchanged** — `podman build` consumes them as-is (validate in M0) |

Each TS module currently has its **own** `runDocker`/`runCompose` copy
(`kokoro-lifecycle.ts`, `sidecar.ts`, `agent-push-installer.ts`). Consolidate.

---

## 2. Architecture: the runtime abstraction

**New `app/src-electron/container-runtime.ts`** — single chokepoint:

- `resolveEngine()` → returns `podman` (preferred) or `docker` (fallback
  during upgrade window, Open Q #4); caches the resolved binary path.
- `runEngine(args, opts)` → the consolidated `spawn` + timeout + capture
  helper (replaces the three duplicated `runDocker`s).
- `diagnoseEngineError(action, result)` → unify the error mappers already
  duplicated across `agent-push-installer.ts` / `kokoro-lifecycle.ts`
  (daemon down → "is the Podman machine started?", permission, no-such-
  container, disk full, registry rate-limit).
- `ensureRuntime()` → the single gate every lifecycle call funnels through:
  on macOS/Windows ensures `podman machine` is up (§3); on Linux is a no-op.

**Shell/Make:** scripts read `CONTAINER_ENGINE="${CONTAINER_ENGINE:-podman}"`
and replace literal `docker`. `Makefile` gets `ENGINE ?= podman` and
`check-prereqs` validates podman (+ machine on mac/win).

The TS lifecycle module becomes the **canonical** path for the app;
`start-hermes.sh` stays for headless/dev use with shared documented defaults
(avoid two silently diverging implementations).

---

## 3. `podman machine` lifecycle (macOS / Windows only)

Podman has no always-on daemon. On darwin/win32, before any container op:

1. `podman machine list` — does a machine exist?
2. If not: `podman machine init` — **sized for Hermes + sidecar**
   (default 2 CPU / 2 GB is tight; recommend ~4 CPU / 4 GB, configurable in
   Settings). Default `podman machine` shares `$HOME`, so the `~/.hermes`
   bind mount works as long as Hermes home stays under `$HOME` (it does by
   default) — document this constraint.
3. If stopped: `podman machine start` (cold boot ~20–60 s — Open Q #1).

**New `app/src-electron/podman-machine.ts`** owns this; called only via
`ensureRuntime()`. App startup does a best-effort pre-warm so the first
container action inside a button click isn't a 60 s VM boot; surface a
"Starting Podman VM…" status. On Linux this module is inert.

---

## 4. The sharp technical problems & how we solve them

### 4a. Rootless volume ownership (highest risk)

`~/.hermes` is bind-mounted **and written by both sides**: the host (plugin
copy, `.env` append, log tailing) and the container (agent state, `logs/`).
Rootless Podman maps the container user into a subuid range → container-
created files land owned by a high host UID and host-created files may be
unreadable by the container user.

**RESOLVED in M0 — proven recipe (do not re-litigate):**
```
podman run --userns=keep-id:uid=10000,gid=10000 -v ~/.hermes:/opt/data …
```
The image's `hermes` user is uid/gid **10000**; mapping the host user onto
10000 makes container-written files land host-owned (`501:20` here) and
lets the container read pre-existing `0640` config. Verified end-to-end.
No `HERMES_UID`/`HERMES_GID` env on the Podman path. Docker (rootful) path
keeps using the image's native `-e HERMES_UID=$(id -u) -e HERMES_GID=$(id -g)`
mechanism instead (Docker has no userns by default). The abstraction picks
the right form per engine.

Same care for the sidecar's read-only config bind mount (lower risk, RO).

### 4b. `host.docker.internal` from inside the container

SearXNG config and `start-llm-tunnel.sh` assume the Hermes *container*
reaches the host at `host.docker.internal`. Podman natively exposes
`host.containers.internal`.

**RESOLVED in M0 — near-zero churn.** Podman 5.x **natively** resolves
`host.docker.internal` (aliased to `host.containers.internal`) with **no
flag at all**, and reaches a macOS-host `127.0.0.1`-bound listener through
it. So `model.base_url`, SearXNG URL, and the socat tunnel keep working
**unchanged** on Podman. We still pass
`--add-host=host.docker.internal:host-gateway` defensively for older
Podman, but no script/config edits are required.

### 4d. Docker credsStore poisons anonymous pulls (found in M0)

Podman reads `~/.docker/config.json`. A `credsStore`/`credHelpers` entry
(gcloud, ECR, `desktop`, …) makes even **public** `pull`/`run` fail with a
credential-helper error. `container-runtime.ts` must, for anonymous
registry ops, set `REGISTRY_AUTH_FILE` to a clean `{}` temp file and use
`--pull=never` on `run` (image already local). Applies to Docker too if it
has a broken helper. Non-negotiable for a "normal user" who happens to have
gcloud/Docker-Desktop installed.

### 4c. Compose

`podman compose` (v4.x) shells out to docker-compose or podman-compose —
fragile cross-platform and a tool we don't control. Plan: **convert *both*
the sidecar `compose.*.yml` and `searxng/docker-compose.yml` to plain
`podman run`** in TS lifecycle modules — the Kokoro module already proves
this pattern (named volumes, RO config mount, env var, healthcheck → all
`podman run` flags). SearXNG (searxng + valkey + a `podman network`) is a
bit more wiring, but plain `podman run` is the more stable & supportable
path (Decision #5) — no dependency on the unreliable `podman compose` /
`podman-compose` toolchain. (Docker-engine users get the same `docker run`
invocations via the abstraction; the `compose.*.yml` files can be retired.)

---

## 5. App-managed Podman install (core of goal #2)

**New `app/src-electron/podman-installer.ts`** + Settings UI, following the
existing preview→confirm→steps UX from `agent-push-installer.ts`. **Guided,
explicit-consent — never a silent privileged install:**

- Detect: `podman` on PATH? version ≥ 4.x (needed for `host-gateway` /
  compose semantics)?
- macOS: **Homebrew-first** (`brew install podman`). The repo already
  depends on Homebrew on macOS — `scripts/start-llm-tunnel.sh` does
  `brew install socat` — so Homebrew-first is consistent with what we
  already assume (Decision #2). Keep the official `.pkg` (download + open)
  as a fallback for the Homebrew-less; do not bundle the pkg.
- Windows: `winget install -e --id RedHat.Podman` (winget ships on Win10+);
  `choco` fallback; else official `.msi`.
- Linux: detect distro → surface the exact `sudo apt-get install -y podman`
  / `dnf` / `pacman` command for the user to run (suggest `! sudo …`);
  do not auto-escalate privilege.

---

## 6. App-managed Hermes lifecycle

**New `app/src-electron/hermes-lifecycle.ts`**, mirroring
`kokoro-lifecycle.ts` (`status()` / `ensure()` / `stop()`):

- Owns container name `hermes-personal`, base image
  `nousresearch/hermes-agent`, local browser tag `hermes-faceplate:browser`
  (built from bundled `scripts/hermes/Dockerfile`), `~/.hermes` mount with
  `--userns=keep-id`, ports `8642`/`8643`, `gateway run`, `/v1/health` poll,
  `--add-host=host.docker.internal:host-gateway`.
- **Consolidate the `.env` ensure logic.** The bash `ensure_var` in
  `start-hermes.sh` and the env writer in `agent-push-installer.ts` overlap
  → extract one `app/src-electron/hermes-env.ts` (read / parse / append-only,
  never clobber user values).
- Rework `agent-push-installer.ts`: when the app manages Hermes, use the
  **deterministic** container name. **Keep the `ps` heuristic as a
  first-class supported fallback** for *bring-your-own-Hermes* — a user who
  already runs Hermes bare-metal or in their own container (Decision #4).
  That path stays: plugin install + `.env` wiring still work against a
  user-run Hermes; we just don't manage its lifecycle.
- **Bring-your-own-Hermes (no install):** the existing setup wizard /
  `hermes-discovery.ts` URL+key flow already covers connecting to a Hermes
  the user runs themselves. No new work — just ensure the one-click
  installer is *skippable* and the BYO path stays prominent (it is the only
  supported "bare-metal Hermes" story).
- GUI "Install Hermes Agent" one-click chains (only when the user has no
  Hermes): detect/install Podman → ensure machine → pull base → build
  browser image → run → health-check → wire `.env` + plugin. Each
  privileged/destructive step behind the existing confirm pattern.

---

## 7. Migration path for existing Docker users

- **Hermes data: zero migration.** `~/.hermes` is a host **bind mount**, not
  a Docker named volume → switching engines preserves config / plugins /
  logs / state automatically.
- **Sidecar models: one-time re-download.** Sidecar uses Docker **named
  volumes** (`faceplate-models`, `faceplate-voices`, `faceplate-wakewords`)
  → Podman won't see them; speech models re-download on first Podman sidecar
  start. Acceptable but **must be communicated** in the UI ("first start
  re-downloads speech models, ~X MB").
- **Offboarding old containers:** detect a still-present Docker
  `hermes-personal` / sidecar and offer (confirm dialog, never auto-nuke) to
  stop+remove them so two engines don't double-bind ports 8642 / 8080 / 8643.
- **Permanent dual-engine support** (Decision #1): not an upgrade window —
  Docker stays a first-class supported engine. `container-runtime.ts`
  auto-selects: Podman if present/installed (default, recommended), else an
  already-running Docker. A Settings engine selector lets a Docker user pin
  Docker explicitly. Existing Docker users are never force-migrated; they're
  *offered* the Podman path but "keep using Docker" is a supported choice.

---

## 8. Milestones (dependency-ordered)

| M | Scope | Risk-down / value |
|---|---|---|
| **M0 ✅ DONE** | Spike complete 2026-05-17 (macOS arm64). 4a SOLVED (`--userns=keep-id:uid=10000,gid=10000`), build PASS, host-net PASS (native `host.docker.internal`), sizing PASS (disk = watch-item, ≥20 GB), +credsStore finding (4d). See "M0 results". | **Gate cleared — M1 unblocked.** |
| **M1 ✅ DONE** | Done 2026-05-17. New `app/src-electron/container-runtime.ts` (engine resolve + `runEngine`/`runEngineCompose`/`engineAvailable` + `cleanRegistryAuthEnv` hook for 4d, unused on default path); kokoro/sidecar/agent-push refactored onto it (timeouts/env/no-timeout-compose preserved exactly); `CONTAINER_ENGINE`/`ENGINE` param (default **docker**) in the 3 scripts + Makefile. Verified: no residual `docker` calls, `bash -n` clean, Make substitution docker↔podman, typecheck clean (only a **pre-existing, unrelated** `WizardPage.vue:104 .url` error — proven on clean HEAD via stash). Zero behavior change. | Landed, no user impact |
| **M2 ✅ DONE** | Done 2026-05-17. `podman-machine.ts` (VM lifecycle; macOS/Win, Linux no-op; parse shape validated vs real Podman 5.8.2), `podman-installer.ts` (detect + guided install: brew/winget/manual-sudo + IPC), `ensureRuntime()` gate + `runTool` + Podman-only 4d credsStore isolation in container-runtime.ts, wired into kokoro.ensure / sidecar.start / agentPush.restart (no-op under docker default), IPC contract (preload-api/electron-preload/electron-main), `SettingsPodman.vue` panel + SettingsPage registration. Engine default stays **docker** (selector deferred to M5 per plan). Typecheck fully green; zero behavior change for Docker users. | App can now run fully on Podman |
| **M3 ✅ DONE** | Done 2026-05-17. `hermes-env.ts` (consolidated .env path/parse/append-only + `ensureHermesApiEnv` porting start-hermes.sh `ensure_var`); `agent-push-installer.ts` refactored onto it (dup helpers removed, banner/behavior preserved); `hermes-lifecycle.ts` (status/install/stop, engine-conditional run: Podman `--userns=keep-id:uid=10000,gid=10000` + `--add-host` per M0; Docker = byte-identical to start-hermes.sh today; recreate-on-install, /v1/health poll); IPC contract extended (`hermes.agentStatus/installAgent/stopAgent`); one-click "Hermes Agent" card added to the Container Engine panel. Typecheck fully green. Run recipe == M0-validated Scenario A. NOT launched against the live ~/.hermes in-session (would start an autonomous agent — out of scope; recipe already M0-proven). | The headline feature |
| **M4 ✅ DONE** | Done 2026-05-17. `sidecar.ts` rewritten compose→plain `run` (faithful: name/ports/named-vols/RO-config/env/healthcheck/restart/CUDA-GPU; **pull-first, build-fallback** preserves the ghcr prebuilt fast-path + offline build); new `scripts/start-sidecar.sh` (bash mirror, for `make up`); `start-searxng.sh` → network + valkey(alias `redis`) + searxng plain `run`; Makefile up/down/logs/clean/searxng-* de-composed + compose prereq dropped; **deleted** `sidecar/compose.*.yml` + `searxng/docker-compose.yml`; `quasar.config.ts` now bundles the sidecar **build context** (not compose files). Verified: typecheck clean, `bash -n` all scripts, zero functional `compose` refs, Make substitution docker↔podman. Behavior note: sidecar is now pull-first/build-fallback + config bind is skip-if-absent (both strictly better than the old compose footgun) — intentional, not zero-change (M4 is a conversion milestone). Doc prose still references compose → fixed in M5. | Compose dependency gone, both engines |
| **M5 ✅ DONE** | Done 2026-05-17. `InfraSettings.container_engine` (auto/docker/podman) in the Zod schema; `containerEngine()` reads it (env override → setting → docker sync-fallback); `resolveAndPersistEngine()` smart startup flip (Podman if installed AND no running Docker Hermes → podman, else docker — never yanks a working Docker setup), wired in electron-main `whenReady`; migration UX (`scanLegacyDocker`/`offboardLegacyDocker` + IPC + confirm-gated card); engine selector (`q-btn-toggle` ↔ setting) in SettingsPodman.vue; scripts + Makefile defaults flipped to "Podman if installed else Docker"; docs rewritten (SETUP/QUICKSTART/sidecar READMEs via subagent) + script headers. Typecheck clean; engine resolution verified (podman default, `ENGINE=docker` forces docker). Realizes Decision #1: Podman default, Docker opt-in, never force-migrated. | Clean dual-engine end state |
| **M6 ✅ DONE (rescoped)** | Done 2026-05-17. Repo had zero CI; full ~6 GB image builds infeasible on standard runners (see "M6 reality"). Shipped a **lean GitHub Actions guard** (`.github/workflows/ci.yml`): job 1 = `bash -n` all scripts + installer, "no `compose -f` resurfaced" guard, Makefile engine-substitution assertion (default-resolves + `ENGINE=docker` forces docker); job 2 = `pnpm typecheck` + `pnpm build` matrix on ubuntu/macos/windows (Node 22, pnpm 10, mac signing disabled). All three guard steps + YAML validity verified locally. Full dual-engine image builds + multi-arch e2e are explicitly out of scope (runner limits) and noted as a future release-pipeline concern. | Regression guard in place |

**Install scripts (done 2026-05-17):** `installer/install.sh` + `installer/install.ps1` post-install hints updated — engine-agnostic Kokoro line + point users at Settings → Container Engine for one-click Podman/Hermes install. Installers download the packaged Electron app (engine-agnostic); no other changes needed. `installer/README.md` clean.

**M6 reality (found 2026-05-17):** repo has **zero CI** (no `.github/workflows`). Original M6 "build both ~6 GB images in CI" is **infeasible on standard GitHub runners** (M0: 6 GB image, 14 GB VM vs ~14 GB runner disk + time limits). Realistic M6 = (a) typecheck + `quasar build` matrix on mac/win/linux; (b) a cheap "container recipe guard" (scripts `bash -n`, Makefile engine-substitution, `podman build` of *only* `scripts/hermes/Dockerfile`'s thin layer is still ~6 GB so even that is skipped — instead lint the run-arg construction) — NOT full image builds. Needs a scoping call (CI provider, depth) before implementing.

Both engines are supported throughout; `ENGINE=docker` is a permanent
supported mode, not just a rollback.

---

## 9. Resolved decisions (product review, 2026-05-17)

1. **Podman machine cold-start** — *Resolved:* acceptable with a progress
   state + startup pre-warm. No louder first-run screen needed.
2. **Hermes image internal UID vs `--userns=keep-id`** — *Open, but
   technical not product:* settled by the M0 spike. 4a remains the
   make-or-break unknown and gates M1+.
3. **macOS install** — *Resolved:* Homebrew-first (already a repo
   dependency on macOS); official `.pkg` as the Homebrew-less fallback; do
   not bundle the pkg.
4. **Docker** — *Resolved:* **permanently supported, opt-in.** Not retired.
   Engine abstraction is a permanent feature + a Settings engine selector
   (Podman default/auto-installed; Docker for users who have/prefer it).
5. **SearXNG** — *Resolved:* convert to plain `podman run`/`docker run`
   (most stable & supportable); drop `podman compose` entirely.
6. **Bare-metal Hermes** — *Resolved:* we never install/facilitate it.
   Only supported bare-metal case is *connecting to a user's existing
   Hermes* via the existing URL+key BYO path (§6). The "advanced install
   bare-metal" idea is **dropped** (not tracked as future).

---

## 10. Acceptance criteria (per release)

- Fresh machine, no Docker, no Podman → app guides Podman install →
  one-click Hermes install → `/v1/health` 200 → Hermes Pings plugin connects.
- Existing Docker user upgrades → app offers migration → Hermes data intact
  (no `~/.hermes` loss), sidecar models re-download once, old Docker
  containers offboarded without port clashes.
- Browser tool works (chromium + agent-browser image built under Podman).
- LAN-LLM tunnel + SearXNG still reachable from the container
  (`host.docker.internal` alias intact).
- `ENGINE=docker make hermes-up` still works through M3 (rollback path).
