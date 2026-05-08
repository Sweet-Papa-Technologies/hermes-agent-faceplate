// Avatar theme manifest schema. See DESIGN.md §10.
//
// Loaded at runtime from `themes/<id>/manifest.json` (or compatible JSON paths).
// The renderer validates with zod, then DOMPurify-sanitises any inline SVG
// fragments before mounting them with `v-html`. Manifests with `<script>` or
// `on*` attributes are rejected at load time.

import { z } from 'zod';

const SvgFragmentShape = {
  inline_svg: z.string().optional(),
  src: z.string().optional(),
};

interface SvgSourceCarrier {
  inline_svg?: string | undefined;
  src?: string | undefined;
}

const requireSvgSource = (v: SvgSourceCarrier) =>
  v.inline_svg !== undefined || v.src !== undefined;

const SvgFragment = z
  .object(SvgFragmentShape)
  .refine(requireSvgSource, {
    message: 'SVG layer requires either `inline_svg` or `src`',
  });

const AgentStateEnum = z.enum([
  'idle',
  'listening',
  'thinking',
  'speaking',
  'error',
]);

const Canvas = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bg: z.union([z.string(), z.literal('transparent')]),
});

const EyesLayer = z
  .object({
    ...SvgFragmentShape,
    blink: z
      .object({
        rate_min_s: z.number().nonnegative(),
        rate_max_s: z.number().nonnegative(),
        duration_ms: z.number().nonnegative(),
      })
      .optional(),
  })
  .refine(requireSvgSource, {
    message: 'eyes layer requires `inline_svg` or `src`',
  });

const StateRingLayer = z
  .object({
    ...SvgFragmentShape,
    tint_per_state: z.record(AgentStateEnum, z.string()),
  })
  .refine(requireSvgSource, {
    message: 'state_ring layer requires `inline_svg` or `src`',
  });

const ExtraLayer = z
  .object({
    ...SvgFragmentShape,
    id: z.string(),
  })
  .refine(requireSvgSource, {
    message: 'extras layer requires `inline_svg` or `src`',
  });

const Layers = z.object({
  head: SvgFragment,
  eyes: EyesLayer.optional(),
  state_ring: StateRingLayer.optional(),
  extras: z.array(ExtraLayer).optional(),
});

const Visemes = z.object({
  A: z.string(),
  B: z.string(),
  C: z.string(),
  D: z.string(),
  E: z.string(),
  F: z.string(),
  X: z.string(),
});

const DriverOverrides = z.object({
  spring_k: z.number().optional(),
  spring_c: z.number().optional(),
  silence_ms: z.number().optional(),
  thresholds: z
    .object({
      high: z.number(),
      mid: z.number(),
      low: z.number(),
      silence: z.number(),
    })
    .optional(),
});

const CaptionStyle = z.object({
  font_family: z.string().optional(),
  font_size_px: z.number().positive().optional(),
  color: z.string().optional(),
  background: z.string().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  bottom_offset_px: z.number().optional(),
});

export const AvatarThemeManifest = z.object({
  schema_version: z.literal(1),
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-_]*$/, 'theme id must be a slug'),
  name: z.string(),
  author: z.string().optional(),
  license: z.string().optional(),
  canvas: Canvas,
  layers: Layers,
  visemes: Visemes,
  driver: DriverOverrides.optional(),
  captions: CaptionStyle.optional(),
  assets: z.record(z.string(), z.string()).optional(),
});

export type AvatarThemeManifest = z.infer<typeof AvatarThemeManifest>;

// SVG fragments are rejected if they contain script tags or inline event
// handlers. DOMPurify is the load-time sanitiser; this regex is a fast
// pre-flight check the manifest loader can run before the heavier parse.
export const FORBIDDEN_SVG_PATTERN = /<script\b|\son[a-z]+\s*=/i;
