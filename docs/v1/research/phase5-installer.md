# Phase 5 — One-Liner Installer + Architecture Research

> Research brief produced 2026-05-12 to inform Phase 5 of `v1.todo.md` (Docker-optional + curl installer). Future sessions implementing the installer should re-read this.

## 1. State-of-the-art examples

| Installer | OS/Arch detection | Idempotency | Deps | Errors / rollback | PATH |
|---|---|---|---|---|---|
| **rustup** ([rustup-init.sh](https://github.com/rust-lang/rustup/blob/main/rustup-init.sh)) | `uname -s/-m`, ELF header probe (`od` on `/proc/self/exe`) for 32/64-bit + endian, `ldd` for glibc-vs-musl. POSIX-portable (dash/bash/zsh/ksh) | Re-runs hand off to `rustup-init` binary which is itself idempotent. Connects `/dev/tty` for prompts when stdin is the pipe | Requires only `curl`/`wget`/`fetch` + tar; Rust toolchain itself is bundled | TLS 1.2+ enforced; downloader verifies before exec; functions wrap whole script so partial-download truncation can't run | Appends `source $HOME/.cargo/env` to `.bashrc`/`.zshenv`/etc. |
| **mise** ([mise.run](https://mise.jdx.dev/installing-mise.html)) | Shell installer, x86_64/arm64/armv7, glibc/musl variants, downloads pre-compiled binary | Pinned to a version + checksum baked into the script at fetch time → safe re-run | Self-contained binary | Exits on any failure | User adds `eval "$(mise activate)"` to rc file (does not silently mutate by default) |
| **deno** ([install.sh](https://github.com/denoland/deno_install)) | `uname` based, downloads zip, requires `unzip`/`7z` | Overwrites `$DENO_INSTALL/bin/deno`; safe to re-run | Single static binary | `set -e` style; zip checksum optional | **Prints** export line; user must add manually (long-standing gripe — issue #286) |
| **pnpm** ([get.pnpm.io/install.sh](https://github.com/pnpm/get.pnpm.io/blob/main/install.sh)) | `detect_arch` for x86_64/arm64; libc auto-detected | Wraps `pnpm setup` which is idempotent — creates `$PNPM_HOME`, dedupes shellrc edits | None (static binary) | `set -eu` | `pnpm setup` writes `PNPM_HOME` + PATH to detected rc file |
| **Homebrew** ([install.sh](https://github.com/Homebrew/install/blob/HEAD/install.sh)) | Detects macOS vs Linux, Apple Silicon vs Intel; rejects POSIX mode | Checks for existing brew shellenv lines before adding; will skip if installed | Will install Xcode CLT on macOS | Aborts on prereq miss; companion [`uninstall.sh`](https://github.com/Homebrew/install) | Adds `eval "$(brew shellenv)"` snippet |
| **oh-my-zsh** ([install.sh](https://github.com/ohmyzsh/ohmyzsh)) | bash, zsh-only target | Backs up `.zshrc` → `.zshrc.pre-oh-my-zsh.<n>` | Requires git, zsh | [Uninstaller has known restore bugs (issue 9629)](https://github.com/ohmyzsh/ohmyzsh/issues/9629) | Replaces `.zshrc` from template |

## 2. Cross-OS strategy

Standard practice is **two scripts behind two well-known URLs**, not UA sniffing:

- macOS/Linux: `curl -fsSL https://get.hermes.app/install.sh | sh`
- Windows: `irm https://get.hermes.app/install.ps1 | iex` ([explainer](https://knowledge.buka.sh/powershell-one-liners-for-installation-what-does-irm-bun-sh-install-ps1-iex-really-do/))

UA-sniff redirects from a single URL (rustup, bun, deno do this for the *download page*, not the pipe) work but fail badly when curl follows redirects with the wrong `Accept`; also defeats local inspection (`curl … > inspect.sh`). MDN [discourages UA sniffing](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Browser_detection_using_the_user_agent). Recommend two explicit URLs documented side-by-side (rustup, pnpm, bun, deno all do this).

## 3. Runtime detection + install

Faceplate needs Node ≥20, pnpm, optionally Python ≥3.11.

Three strategies:

| Strategy | Pros | Cons |
|---|---|---|
| **System pkg manager** (brew/apt/dnf/winget) | Native, predictable, easy uninstall | Versions lag; sudo required on Linux; matrix is huge |
| **Version manager** (mise, asdf, fnm, uv) | Same UX everywhere; per-project pins; no sudo | New tool to learn; slower first run |
| **Bundled binaries** | Zero host deps; offline-capable | Big download; manual security patching; native modules per arch |

**Recommendation:** **bundle Node + pnpm inside the packaged Electron app** (Electron already ships its own Node), and use **`mise`** as a fallback/opt-in for Python — mise is single-binary, supports macOS/Linux/Windows, [pins versions with checksums](https://mise.jdx.dev/installing-mise.html), and avoids touching system Python (which is fragile on macOS/Ubuntu). For the no-Docker TTS/STT path, prefer **`uv`** to manage a project-local Python venv — it's faster than pyenv/pip and handles interpreter download.

## 4. App distribution

**Ship a packaged binary**, do not build from source. Source builds require a full toolchain (node-gyp, Python, C++), are slow, and break for non-developers ([node-gyp Python pain](https://github.com/nodejs/node-gyp)).

Use **electron-builder** ([docs](https://www.electron.build)) for `.dmg` + `.zip` (mac), `.AppImage` + `.deb` (Linux), `.exe` NSIS (Windows). Electron Forge is also viable but electron-builder is preferred when targeting AppImage+deb+rpm in one build ([2026 guide](https://dev.to/raxxostudios/how-to-build-and-distribute-an-electron-desktop-app-in-2026-24nk)).

Platform requirements:
- **macOS:** Developer ID cert ($99/yr), `hardenedRuntime: true`, [`@electron/notarize`](https://github.com/electron/notarize) — mandatory since 10.15 or Gatekeeper blocks first launch
- **Windows:** unsigned binaries trigger SmartScreen blocks; use **Azure Trusted Signing** (cheapest modern option, replaces EV certs; CA/B Forum cut max cert life to ~15 months effective March 2026)
- **Linux:** AppImage is most universal; installer should drop a `.desktop` file in `~/.local/share/applications` and an icon in `~/.local/share/icons/hicolor/`

Auto-update via **electron-updater** ([guide](https://blog.nishikanta.in/implementing-auto-updates-in-electron-with-electron-updater)) pointing at GitHub Releases or your own static host.

## 5. Idempotency + uninstall

Patterns from the field:
- **Existence check + version compare** before any mutation (Homebrew checks `brew shellenv` line before re-adding)
- **Backup mutated files** with timestamped suffix (oh-my-zsh: `.zshrc.pre-…`)
- **All install state under one prefix** (`~/.cargo`, `~/.deno`, `~/.local/share/pnpm`, `~/.local/share/mise`) so uninstall = `rm -rf $PREFIX` + remove rc lines
- **Ship a sibling `uninstall.sh`** at the same URL ([Homebrew pattern](https://github.com/Homebrew/install))
- **Markers in shell rc** wrapped in `# >>> hermes >>>` / `# <<< hermes <<<` blocks so removal is a single `sed` block delete (mise/conda style)

## 6. Security

`curl | sh` is criticized because (a) connection truncation can execute partial scripts, (b) the server can [detect piping vs. saving and serve different bytes](https://www.lesinskis.com/dont-pipe-curl-into-bash.html), (c) no integrity check. Common mitigations ([Sysdig](https://www.sysdig.com/blog/friends-dont-let-friends-curl-bash), [arp242](https://www.arp242.net/curl-to-sh.html)):

- **Wrap entire script in `main()`** called only on the last line — truncation can't execute partial logic (rustup pattern)
- **Serve over HTTPS only** with HSTS; reject HTTP
- **Publish SHA-256 + GPG/cosign signatures** for the script and every binary it downloads; verify in-script
- **Document a two-step path**: `curl -fsSL … -o hermes-install.sh && less hermes-install.sh && sh hermes-install.sh`
- **Pin downstream binary URLs to versioned, immutable paths** with embedded checksums (mise/rustup)
- **Host on a dedicated domain** you control end-to-end (`get.hermesagent.app`), not a generic CDN bucket

## 7. Concrete recommendation for HermesAgent Faceplate (Phase 5)

1. **URLs:** `https://get.hermesagent.app/install.sh` (POSIX) and `https://get.hermesagent.app/install.ps1` (Windows). HTTPS-only, served from a CDN you control; both scripts wrapped in `main()` with last-line invocation.
2. **One-liner UX:** `curl -fsSL https://get.hermesagent.app/install.sh | sh` and `irm https://get.hermesagent.app/install.ps1 | iex`. Document the inspect-first variant prominently.
3. **OS/arch detection:** `uname -s/-m` + libc probe (rustup-style) on POSIX; `$env:PROCESSOR_ARCHITECTURE` + `[System.Environment]::OSVersion` on Windows.
4. **Prefix:** Install everything under `$HOME/.hermes/` (POSIX) and `%LOCALAPPDATA%\Hermes\` (Windows). State, logs, models, venvs, app binary all live here.
5. **Step-by-step:** detect OS/arch → check `$HOME/.hermes/version` → fetch latest manifest JSON (`channels/stable.json`) containing version + per-platform URLs + SHA-256 → download packaged Electron app to temp → verify checksum → atomically move into prefix → install OS integration (drag-to-Applications hint on mac, `.desktop` file on Linux, Start Menu shortcut on Windows) → write rc-block wrapper for `hermes` CLI shim → print next-steps.
6. **No bundled Node/Python on host** — Electron carries its own Node; the app spawns its own runtime. Python only needed if user opts into local TTS/STT, in which case the app's first-run wizard fetches `uv` and provisions a venv under `$HOME/.hermes/python/`. Docker is detected and offered as opt-in but never required.
7. **Idempotency:** re-running compares manifest version against `version` file; no-op if equal, in-place upgrade if newer. All rc edits wrapped in `# >>> hermes >>>` markers checked before append.
8. **Updates:** delegate to **electron-updater** against the same manifest URL once installed; the shell installer is only for first-install and disaster recovery.
9. **Uninstall:** sibling `uninstall.sh`/`uninstall.ps1` at the same domain. Removes prefix, rc markers, `.desktop` entry, Start Menu shortcut, login items. Prompts before deleting `state/` (user data).
10. **Security:** sign all release artifacts (Apple Developer ID + notarize, Azure Trusted Signing for Windows, cosign for Linux AppImage). Manifest itself signed; installer verifies signature before trusting download URLs.
11. **Logging/telemetry:** every step appended to `$HOME/.hermes/install.log` with a one-line summary printed; a final URL with the run-id for support.
12. **CI:** generate `install.sh`/`install.ps1` from a single source (envsubst or a small Go tool) so version constants and checksums stay in sync; publish via the same GitHub Release that builds the Electron artifacts.

## Sources

- [rustup-init.sh on GitHub](https://github.com/rust-lang/rustup/blob/main/rustup-init.sh) and [DeepWiki overview](https://deepwiki.com/rust-lang/rustup/5.1-rustup-init-installer)
- [pnpm install.sh source](https://github.com/pnpm/get.pnpm.io/blob/main/install.sh) and [pnpm setup docs](https://pnpm.io/cli/setup)
- [mise installing docs](https://mise.jdx.dev/installing-mise.html), [DeepWiki](https://deepwiki.com/jdx/mise/2-installation-and-setup)
- [deno_install repo](https://github.com/denoland/deno_install) and [Deno installation docs](https://docs.deno.com/runtime/getting_started/installation/)
- [Homebrew install.sh](https://github.com/Homebrew/install/) and [Installation docs](https://docs.brew.sh/Installation)
- [oh-my-zsh ohmyzsh repo](https://github.com/ohmyzsh/ohmyzsh) and [uninstall bug 9629](https://github.com/ohmyzsh/ohmyzsh/issues/9629)
- [PowerShell irm | iex explainer](https://knowledge.buka.sh/powershell-one-liners-for-installation-what-does-irm-bun-sh-install-ps1-iex-really-do/), [Chocolatey install docs](https://docs.chocolatey.org/en-us/choco/setup/), [winget-install](https://github.com/asheroto/winget-install)
- [electron-builder](https://www.electron.build/), [Electron code-signing docs](https://www.electronjs.org/docs/latest/tutorial/code-signing), [@electron/notarize](https://github.com/electron/notarize), [electron-updater guide](https://blog.nishikanta.in/implementing-auto-updates-in-electron-with-electron-updater), [2026 distribution guide](https://dev.to/raxxostudios/how-to-build-and-distribute-an-electron-desktop-app-in-2026-24nk)
- [node-gyp Python woes](https://github.com/nodejs/node-gyp), [nvm + uv guide](https://dev.to/kingyou/managing-nodejs-and-python-versions-a-step-by-step-guide-with-nvm-and-uv-1099)
- [Sysdig: Friends don't let friends curl|bash](https://www.sysdig.com/blog/friends-dont-let-friends-curl-bash), [arp242: curl-to-sh isn't so bad](https://www.arp242.net/curl-to-sh.html), [Lesinskis: another reason](https://www.lesinskis.com/dont-pipe-curl-into-bash.html), [DEV: trustworthy curl|bash workflow](https://dev.to/operous/how-to-build-a-trustworthy-curl-pipe-bash-workflow-4bb), [silentbicycle/curlbash](https://github.com/silentbicycle/curlbash)
- [MDN: UA sniffing discouraged](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Browser_detection_using_the_user_agent)
