#!/usr/bin/env node
/**
 * Generates THIRD_PARTY_NOTICES.md at the repo root.
 *
 * Walks the production-only dependency tree (resolved from app/package.json
 * via pnpm), records each package's name, version, license, and homepage,
 * and appends a hand-curated section for sidecar bundled binaries +
 * model weights. Run via `pnpm run notices`.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_DIR, '..');

function pnpmList() {
  // `pnpm list --json --prod --depth Infinity` returns the full prod tree.
  // We dedupe by name+version on the way down.
  const raw = execSync('pnpm list --json --prod --depth Infinity --long', {
    cwd: APP_DIR,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function flattenDeps(node, into) {
  if (!node || typeof node !== 'object') return;
  for (const [name, info] of Object.entries(node)) {
    if (!info || typeof info !== 'object') continue;
    if (!info.version) continue;
    const key = `${name}@${info.version}`;
    if (into.has(key)) continue;
    into.set(key, {
      name,
      version: info.version,
      license: info.license || 'UNKNOWN',
      path: info.path,
      homepage: info.homepage || null,
    });
    if (info.dependencies) flattenDeps(info.dependencies, into);
  }
}

function readLicenseText(pkgPath) {
  if (!pkgPath) return '';
  for (const candidate of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'license']) {
    const p = path.join(pkgPath, candidate);
    if (existsSync(p)) {
      const text = readFileSync(p, 'utf8');
      // Trim aggressively — top of file usually carries the meaningful header
      return text.length > 4000 ? text.slice(0, 4000) + '\n... [truncated]' : text;
    }
  }
  return '';
}

const SIDECAR_BUNDLE = [
  { name: 'Piper TTS', version: 'pinned per voice', license: 'MIT', notes: 'rhasspy/piper-voices, OHF-Voice/piper1-gpl' },
  { name: 'Kokoro-FastAPI (cuda image only)', version: 'v0.4.0', license: 'Apache-2.0', notes: 'remsky/Kokoro-FastAPI; Kokoro-82M weights are Apache 2.0 (hexgrad/Kokoro-82M)' },
  { name: 'faster-whisper', version: '>=1.1', license: 'MIT', notes: 'Systran/faster-whisper-* CT2 builds' },
  { name: 'openWakeWord', version: '>=0.6', license: 'Apache-2.0', notes: 'dscripka/openWakeWord' },
  { name: 'Gemma 4 E2B (paraphrase fallback)', version: 'gemma-4-E2B-it.litertlm', license: 'Gemma terms (commercial OK)', notes: 'litert-community/gemma-4-E2B-it-litert-lm' },
  { name: 'LiteRT-LM runtime', version: '0.7.3', license: 'Apache-2.0', notes: 'google-ai-edge/LiteRT-LM' },
  { name: 'litert-lm-api-server', version: 'v0.3.0', license: 'MIT', notes: 'imertz/litert-lm-api-server' },
  { name: 'ffmpeg', version: 'system package', license: 'LGPL-2.1+ (with build-time selectable GPL)', notes: 'used for PCM → MP3 / Opus muxing' },
];

function build() {
  const tree = pnpmList();
  const flat = new Map();
  for (const root of tree) {
    if (root.dependencies) flattenDeps(root.dependencies, flat);
  }
  const sorted = [...flat.values()].sort((a, b) => a.name.localeCompare(b.name));

  const lines = [];
  lines.push('# Third-party notices');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()} from app/package.json (production only).`);
  lines.push('Includes the renderer + Electron app dependency tree, plus hand-curated entries for the speech sidecar.');
  lines.push('');
  lines.push('## Sidecar bundle (Docker)');
  lines.push('');
  lines.push('| Component | Version | License | Notes |');
  lines.push('|-----------|---------|---------|-------|');
  for (const s of SIDECAR_BUNDLE) {
    lines.push(`| ${s.name} | ${s.version} | ${s.license} | ${s.notes} |`);
  }
  lines.push('');
  lines.push('## Faceplate app dependencies (npm)');
  lines.push('');
  lines.push('| Package | Version | License |');
  lines.push('|---------|---------|---------|');
  for (const dep of sorted) {
    lines.push(`| ${dep.name} | ${dep.version} | ${dep.license} |`);
  }

  // Top 50 most important (by alphabetical) get their full LICENSE text appended.
  // We cap to avoid producing a 5 MB file.
  const HEADLINE = ['vue', 'quasar', 'pinia', 'vue-router', 'electron', 'electron-builder', 'electron-updater', 'openai', 'zod', 'yaml', 'dotenv', 'dompurify'];
  lines.push('');
  lines.push('## Headline package licenses (full text)');
  for (const name of HEADLINE) {
    const dep = sorted.find((d) => d.name === name);
    if (!dep) continue;
    const text = readLicenseText(dep.path);
    if (!text) continue;
    lines.push('');
    lines.push(`### ${dep.name}@${dep.version} — ${dep.license}`);
    lines.push('');
    lines.push('```');
    lines.push(text.trim());
    lines.push('```');
  }

  const out = path.join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md');
  writeFileSync(out, lines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${out} (${sorted.length} packages, ${SIDECAR_BUNDLE.length} sidecar entries)`);
}

build();
