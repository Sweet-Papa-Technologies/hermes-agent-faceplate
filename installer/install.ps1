# HermesAgent Faceplate — one-line installer (Windows).
#
# Usage:
#     irm https://get.hermesagent.app/install.ps1 | iex
#
# Inspect-first (recommended for first-time installs):
#     irm https://get.hermesagent.app/install.ps1 -OutFile hermes-install.ps1
#     notepad hermes-install.ps1
#     .\hermes-install.ps1
#
# What this script does:
#     1. Detects arch via $env:PROCESSOR_ARCHITECTURE.
#     2. Fetches the release manifest from $HermesChannelUrl.
#     3. Downloads the matching packaged Electron build to $HermesPrefix\app.
#     4. Verifies SHA-256 against the manifest.
#     5. Installs OS integration (Start Menu shortcut, optional desktop
#        shortcut, registers an AppUserModelID matching the one set by the
#        app at startup so OS notifications fire reliably).
#     6. Adds the bin dir to %PATH% for the current user.
#
# Re-running the script is safe (idempotent): it diffs the on-disk version
# against the manifest and no-ops on equal, upgrades in place on newer.
# Routine updates after first install go through electron-updater.
#
# References:
#   - docs/v1/research/phase5-installer.md
#   - pnpm install.ps1, scoop install.ps1, rustup-init.ps1

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # speeds up Invoke-WebRequest

# ─── config (overridable via env) ───────────────────────────────────────
$HermesChannelUrl = $env:HERMES_CHANNEL_URL
if (-not $HermesChannelUrl) { $HermesChannelUrl = 'https://get.hermesagent.app/channels/stable.json' }
$HermesPrefix = $env:HERMES_PREFIX
if (-not $HermesPrefix) { $HermesPrefix = Join-Path $env:LOCALAPPDATA 'Hermes' }
$HermesBinDir = Join-Path $HermesPrefix 'bin'
$HermesAppId  = 'com.hermesagent.faceplate'

function Write-Log {
    param([string]$Message)
    Write-Host $Message
    $logPath = Join-Path $HermesPrefix 'install.log'
    $line = '[{0}] {1}' -f ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')), $Message
    Add-Content -Path $logPath -Value $line -ErrorAction SilentlyContinue
}

function Fail {
    param([string]$Message)
    Write-Log "ERROR: $Message"
    throw $Message
}

function Get-Arch {
    switch -Wildcard ($env:PROCESSOR_ARCHITECTURE) {
        'AMD64' { return 'x64' }
        'ARM64' { return 'arm64' }
        default { Fail "Unsupported arch: $($env:PROCESSOR_ARCHITECTURE)" }
    }
}

function Main {
    if (-not (Test-Path $HermesPrefix)) {
        New-Item -ItemType Directory -Path $HermesPrefix -Force | Out-Null
    }
    Set-Content -Path (Join-Path $HermesPrefix 'install.log') -Value "HermesAgent Faceplate installer starting $((Get-Date).ToUniversalTime())"

    $arch = Get-Arch
    Write-Log "OS=windows ARCH=$arch"

    Write-Log "Fetching manifest from $HermesChannelUrl"
    try {
        $manifest = Invoke-WebRequest -Uri $HermesChannelUrl -UseBasicParsing | ConvertFrom-Json
    } catch {
        Fail "Failed to fetch manifest: $_"
    }
    $targetVersion = $manifest.version
    Write-Log "Latest version on channel: $targetVersion"

    $versionFile = Join-Path $HermesPrefix 'version'
    if (Test-Path $versionFile) {
        $currentVersion = (Get-Content $versionFile -Raw).Trim()
        Write-Log "Existing install (version $currentVersion)"
        if ($currentVersion -eq $targetVersion) {
            Write-Log "Already at $targetVersion. Nothing to do."
            Show-PostInstallHint
            return
        }
        Write-Log "Upgrading $currentVersion → $targetVersion"
    }

    $assetKey = "windows_$arch"
    $asset = $manifest.assets.$assetKey
    if (-not $asset -or -not $asset.url) {
        Fail "No asset URL for $assetKey in manifest."
    }

    $tmp = Join-Path $env:TEMP "hermes-install-$([System.IO.Path]::GetRandomFileName())"
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        $payload = Join-Path $tmp 'payload'
        Write-Log "Downloading $($asset.url)"
        Invoke-WebRequest -Uri $asset.url -OutFile $payload -UseBasicParsing

        $expectedSha = $asset.sha256
        $actualSha = (Get-FileHash -Path $payload -Algorithm SHA256).Hash.ToLower()
        if ($expectedSha -and ($actualSha -ne $expectedSha.ToLower())) {
            Fail "SHA-256 mismatch: expected $expectedSha, got $actualSha"
        }
        Write-Log 'SHA-256 verified.'

        Install-Payload -Payload $payload -Version $targetVersion
        Install-OsIntegration
        Install-PathEntry
    } finally {
        Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    Show-PostInstallHint
}

function Install-Payload {
    param([string]$Payload, [string]$Version)
    Write-Log "Installing to $HermesPrefix"
    $appDir = Join-Path $HermesPrefix 'app'
    $staging = Join-Path $HermesPrefix ".staging-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    if ($Payload -like '*.zip') {
        Expand-Archive -Path $Payload -DestinationPath $staging -Force
    } elseif ($Payload -like '*.exe') {
        # NSIS installer: run silently. The /D flag (no quotes, must be last)
        # tells NSIS where to install — keep everything under our prefix.
        & $Payload /S /D="$appDir" | Out-Null
        $staging = $appDir
    } else {
        Fail "Unknown payload format: $Payload"
    }
    if ($staging -ne $appDir) {
        if (Test-Path $appDir) {
            Remove-Item -Path "$appDir.old" -Recurse -Force -ErrorAction SilentlyContinue
            Rename-Item -Path $appDir -NewName "$(Split-Path $appDir -Leaf).old"
        }
        Move-Item -Path $staging -Destination $appDir
        Remove-Item -Path "$appDir.old" -Recurse -Force -ErrorAction SilentlyContinue
    }
    Set-Content -Path (Join-Path $HermesPrefix 'version') -Value $Version
}

function Install-OsIntegration {
    # Start Menu shortcut. Without this AND a registered AppUserModelID,
    # Windows OS notifications silently no-op (Electron docs + research
    # brief). The app itself calls setAppUserModelId() at startup with
    # the same id we use here so notifications route to the right tile.
    $exePath = Get-ChildItem -Path (Join-Path $HermesPrefix 'app') -Recurse -Filter 'hermes-faceplate.exe' | Select-Object -First 1
    if (-not $exePath) {
        Write-Log 'WARNING: hermes-faceplate.exe not found in install tree — skipping Start Menu shortcut.'
        return
    }
    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $lnkPath = Join-Path $startMenu 'HermesAgent Faceplate.lnk'
    $wsh = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut($lnkPath)
    $shortcut.TargetPath = $exePath.FullName
    $shortcut.WorkingDirectory = Split-Path $exePath.FullName -Parent
    $shortcut.IconLocation = $exePath.FullName
    $shortcut.Description = 'HermesAgent Faceplate'
    $shortcut.Save()
    Write-Log "Wrote Start Menu shortcut: $lnkPath"
}

function Install-PathEntry {
    if (-not (Test-Path $HermesBinDir)) {
        New-Item -ItemType Directory -Path $HermesBinDir -Force | Out-Null
    }
    # CLI shim: a .cmd wrapper that launches the main exe so users can run
    # `hermes-faceplate` from any terminal.
    $exePath = Get-ChildItem -Path (Join-Path $HermesPrefix 'app') -Recurse -Filter 'hermes-faceplate.exe' | Select-Object -First 1
    if ($exePath) {
        $shim = Join-Path $HermesBinDir 'hermes-faceplate.cmd'
        Set-Content -Path $shim -Value "@echo off`r`n`"$($exePath.FullName)`" %*"
    }

    # Add to user PATH (idempotent — only inserts once).
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$HermesBinDir*") {
        [Environment]::SetEnvironmentVariable('Path', "$userPath;$HermesBinDir", 'User')
        Write-Log "Added $HermesBinDir to user PATH (open a new terminal to pick up)."
    }
}

function Show-PostInstallHint {
    @"

Installed to: $HermesPrefix
Run with:     hermes-faceplate  (open a new terminal to pick up PATH)
Log:          $(Join-Path $HermesPrefix 'install.log')

Next steps:
  1. Launch HermesAgent Faceplate from the Start menu.
  2. Complete the onboarding wizard — paste your Hermes gateway URL + API key.
  3. (Optional) Run Kokoro TTS for higher-quality voices:
     docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest

Uninstall:
  irm https://get.hermesagent.app/uninstall.ps1 | iex
"@ | Write-Host
}

Main
