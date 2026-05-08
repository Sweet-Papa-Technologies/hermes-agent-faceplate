// Theme loader — runs in the renderer.
//
// Built-in themes live under `src/themes/<id>/` and are bundled by Vite.
// User-supplied themes live in `<userData>/themes/<id>/` and are fetched via
// IPC (`window.faceplate.themes.load`). Both go through the same validation
// and sanitisation pipeline.

import DOMPurify from 'dompurify';
import { z } from 'zod';

import {
  AvatarThemeManifest,
  FORBIDDEN_SVG_PATTERN,
  type AvatarThemeManifest as AvatarThemeManifestT,
} from './manifest-schema';
import type { VisemeCode } from '../hermes/event-schema';

const builtinManifests = import.meta.glob<{ default: unknown }>(
  './*/manifest.json',
  { eager: true },
);
const builtinSvgs = import.meta.glob<string>('./*/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
});

function builtinDirOf(themeId: string): string | null {
  for (const key of Object.keys(builtinManifests)) {
    if (key === `./${themeId}/manifest.json`) return `./${themeId}`;
  }
  return null;
}

function readBuiltinSvg(themeDir: string, name: string): string | null {
  const key = `${themeDir}/${name}`;
  return builtinSvgs[key] ?? null;
}

function sanitiseSvgFragment(svg: string): string {
  if (FORBIDDEN_SVG_PATTERN.test(svg)) {
    throw new Error('Theme rejected: SVG fragment contains scripts or event handlers.');
  }
  // Mutable arrays so the dompurify Config type accepts them under
  // exactOptionalPropertyTypes/strict mode; SVG profile already drops
  // <script> but we belt-and-brace for older DOMPurify builds.
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_ATTR: ['onload', 'onclick', 'onerror', 'onmouseover'],
    FORBID_TAGS: ['script'],
    RETURN_TRUSTED_TYPE: false,
  }) as unknown as string;
}

interface ResolvedSvgFragment {
  inline_svg: string;
}

interface LoadedSvgSource {
  inline_svg?: string | undefined;
  src?: string | undefined;
}

function resolveFragment(
  fragment: LoadedSvgSource,
  themeDir: string | null,
): ResolvedSvgFragment {
  let raw: string | null = null;
  if (fragment.inline_svg) raw = fragment.inline_svg;
  else if (fragment.src && themeDir) raw = readBuiltinSvg(themeDir, fragment.src);
  if (raw === null) {
    throw new Error(`Theme asset not found: ${fragment.src ?? '<inline>'}`);
  }
  return { inline_svg: sanitiseSvgFragment(raw) };
}

export interface LoadedTheme {
  manifest: AvatarThemeManifestT;
  /** sanitised inline SVG keyed by layer name (head, state_ring, eyes...) */
  svg: Record<string, string>;
  /** sanitised viseme fragments by code */
  visemes: Record<VisemeCode, string>;
  /** state_ring tint per agent state, with sane defaults */
  ringTints: Record<'idle' | 'listening' | 'thinking' | 'speaking' | 'error', string>;
}

const DEFAULT_RING_TINTS = {
  idle: '#888888',
  listening: '#06b6d4',
  thinking: '#f59e0b',
  speaking: '#22c55e',
  error: '#ef4444',
} as const;

export async function loadTheme(id: string): Promise<LoadedTheme> {
  const builtinDir = builtinDirOf(id);
  let raw: unknown;
  if (builtinDir) {
    const mod = builtinManifests[`${builtinDir}/manifest.json`]!;
    raw = mod.default;
  } else if (typeof window !== 'undefined' && window.faceplate?.themes?.load) {
    raw = await window.faceplate.themes.load(id);
  } else {
    throw new Error(`Theme not found: ${id}`);
  }

  const parsed = AvatarThemeManifest.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Theme manifest invalid: ${parsed.error.message}`);
  }
  const manifest = parsed.data;

  const svg: Record<string, string> = {};
  svg.head = resolveFragment(manifest.layers.head, builtinDir).inline_svg;
  if (manifest.layers.eyes) {
    svg.eyes = resolveFragment(manifest.layers.eyes, builtinDir).inline_svg;
  }
  if (manifest.layers.state_ring) {
    svg.state_ring = resolveFragment(manifest.layers.state_ring, builtinDir).inline_svg;
  }
  for (const extra of manifest.layers.extras ?? []) {
    svg[extra.id] = resolveFragment(extra, builtinDir).inline_svg;
  }

  const visemes: Record<VisemeCode, string> = {
    A: sanitiseSvgFragment(manifest.visemes.A),
    B: sanitiseSvgFragment(manifest.visemes.B),
    C: sanitiseSvgFragment(manifest.visemes.C),
    D: sanitiseSvgFragment(manifest.visemes.D),
    E: sanitiseSvgFragment(manifest.visemes.E),
    F: sanitiseSvgFragment(manifest.visemes.F),
    X: sanitiseSvgFragment(manifest.visemes.X),
  };

  const ringTints = {
    ...DEFAULT_RING_TINTS,
    ...(manifest.layers.state_ring?.tint_per_state ?? {}),
  };

  return { manifest, svg, visemes, ringTints };
}

export function listBuiltinThemes(): { id: string; name: string }[] {
  return Object.entries(builtinManifests).map(([key, mod]) => {
    const id = key.replace(/^\.\/(.+?)\/manifest\.json$/, '$1');
    const m = mod.default as { id?: string; name?: string };
    return { id: m.id ?? id, name: m.name ?? id };
  });
}

export const __test = { sanitiseSvgFragment, z };
