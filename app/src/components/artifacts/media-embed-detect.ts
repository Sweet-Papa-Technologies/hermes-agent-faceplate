// Pattern-matches well-known media URLs (YouTube, Vimeo, Spotify, etc.)
// and returns the iframe embed configuration to render.
//
// Most third-party media services expose a watch/listen page URL but don't
// allow embedding via plain <video src=...> / <audio src=...> tags — the
// browser blocks cross-origin streaming and the page returns HTML, not raw
// media bytes. Instead they ship an /embed/ endpoint that's iframe-friendly.
//
// We support the common ones; for anything else, the renderer falls back
// to the native <video>/<audio>/<img> tag and lets the platform try.

export type EmbedKind = 'youtube' | 'vimeo' | 'twitch' | 'dailymotion' | 'spotify' | 'soundcloud' | 'bandcamp' | 'apple-music' | 'twitter' | 'instagram';

export interface EmbedConfig {
  kind: EmbedKind;
  /** URL to put in <iframe src="..."> */
  src: string;
  /** Optional aspect ratio hint (width / height) — most video is 16:9. */
  aspectRatio?: number;
  /** What `allow=...` permissions the iframe needs. */
  allow?: string;
}

interface Pattern {
  kind: EmbedKind;
  /** Returns the embed URL if this pattern matches, null otherwise. */
  match: (url: URL) => string | null;
  aspectRatio?: number;
  allow?: string;
}

// Pulled out as a constant so we can reuse for video AND audio detection.
// We try every pattern in order and return the first match.
const PATTERNS: Pattern[] = [
  // YouTube — multiple URL shapes
  {
    kind: 'youtube',
    aspectRatio: 16 / 9,
    allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen',
    match: (u) => {
      const id = parseYouTubeId(u);
      return id ? `https://www.youtube.com/embed/${id}` : null;
    },
  },
  // Vimeo — vimeo.com/<id> or player.vimeo.com/video/<id>
  {
    kind: 'vimeo',
    aspectRatio: 16 / 9,
    allow: 'autoplay; fullscreen; picture-in-picture',
    match: (u) => {
      if (u.hostname === 'player.vimeo.com' && u.pathname.startsWith('/video/')) {
        return u.toString();
      }
      if (u.hostname.endsWith('vimeo.com')) {
        const id = u.pathname.split('/').filter(Boolean)[0];
        if (id && /^\d+$/.test(id)) return `https://player.vimeo.com/video/${id}`;
      }
      return null;
    },
  },
  // Twitch VODs + clips
  {
    kind: 'twitch',
    aspectRatio: 16 / 9,
    allow: 'autoplay; fullscreen',
    match: (u) => {
      if (!u.hostname.endsWith('twitch.tv')) return null;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'videos' && parts[1]) {
        return `https://player.twitch.tv/?video=v${parts[1]}&parent=localhost`;
      }
      if (parts.length === 1 && parts[0]) {
        // Channel page → live player
        return `https://player.twitch.tv/?channel=${parts[0]}&parent=localhost`;
      }
      return null;
    },
  },
  // Dailymotion
  {
    kind: 'dailymotion',
    aspectRatio: 16 / 9,
    allow: 'autoplay; fullscreen; picture-in-picture',
    match: (u) => {
      if (!u.hostname.endsWith('dailymotion.com')) return null;
      const m = u.pathname.match(/\/video\/([\w]+)/);
      return m ? `https://www.dailymotion.com/embed/video/${m[1]}` : null;
    },
  },
  // Spotify — track / album / playlist / show / episode
  {
    kind: 'spotify',
    aspectRatio: 5 / 4,
    allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture',
    match: (u) => {
      if (!u.hostname.endsWith('spotify.com')) return null;
      const m = u.pathname.match(/\/(track|album|playlist|show|episode|artist)\/([\w]+)/);
      return m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}` : null;
    },
  },
  // SoundCloud — uses oEmbed-style iframe with the track URL passed in
  {
    kind: 'soundcloud',
    aspectRatio: 5 / 1,
    allow: 'autoplay',
    match: (u) => {
      if (!u.hostname.endsWith('soundcloud.com')) return null;
      const enc = encodeURIComponent(u.toString());
      return `https://w.soundcloud.com/player/?url=${enc}&color=%237fdcff&auto_play=false&hide_related=true&visual=true`;
    },
  },
  // Bandcamp — uses an album/track id encoded in URL; we don't always
  // have it, so fall back to the player on the page when possible.
  {
    kind: 'bandcamp',
    aspectRatio: 4 / 3,
    match: (u) => {
      // Bandcamp embeds need explicit album= or track= numeric IDs that
      // aren't in the page URL — link the page directly so the user can
      // click through.
      if (!u.hostname.endsWith('bandcamp.com')) return null;
      // Render as link only; no embed.
      return null;
    },
  },
  // Apple Music — embed via embed.music.apple.com
  {
    kind: 'apple-music',
    aspectRatio: 5 / 3,
    allow: 'autoplay *; encrypted-media *; fullscreen *',
    match: (u) => {
      if (u.hostname !== 'music.apple.com') return null;
      const embedUrl = u.toString().replace('music.apple.com', 'embed.music.apple.com');
      return embedUrl;
    },
  },
];

export function detectEmbed(rawUrl: string): EmbedConfig | null {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  for (const p of PATTERNS) {
    const src = p.match(u);
    if (src) {
      const cfg: EmbedConfig = { kind: p.kind, src };
      if (p.aspectRatio !== undefined) cfg.aspectRatio = p.aspectRatio;
      if (p.allow !== undefined) cfg.allow = p.allow;
      return cfg;
    }
  }
  return null;
}

function parseYouTubeId(u: URL): string | null {
  const host = u.hostname.replace(/^www\./, '');
  // youtu.be/<id>
  if (host === 'youtu.be') {
    const id = u.pathname.replace('/', '');
    return /^[\w-]{6,}$/.test(id) ? id : null;
  }
  // youtube.com/watch?v=<id>
  if (host.endsWith('youtube.com') || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') {
      const v = u.searchParams.get('v');
      return v && /^[\w-]{6,}$/.test(v) ? v : null;
    }
    // youtube.com/embed/<id>, /shorts/<id>, /live/<id>
    const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{6,})/);
    if (m) return m[1] ?? null;
    // youtube.com/playlist?list=... → can't direct-embed a playlist as a
    // single video; emit the embed of the first item via list= param.
    if (u.pathname === '/playlist') {
      const list = u.searchParams.get('list');
      // Return the videoseries URL for the playlist player.
      return list ? `videoseries?list=${list}` : null;
    }
  }
  return null;
}
