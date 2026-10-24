import type { Platform } from '@vf/shared';

export interface ParsedPostUrl {
  platformPostId: string | null;
}

const hostOf = (u: URL) => u.hostname.toLowerCase().replace(/^(www|m|web)\./, '');
const seg = (u: URL) => u.pathname.split('/').filter(Boolean);
const ok = (id: string | null | undefined): ParsedPostUrl => ({ platformPostId: id ?? null });

const YT_ID = /^[\w-]{11}$/;
const NUM = /^\d+$/;
const IG_CODE = /^[\w-]+$/;
const IG_KINDS = ['reel', 'reels', 'p'];

const parsers: Record<Platform, (u: URL, host: string, s: string[]) => ParsedPostUrl | null> = {
  youtube(u, host, s) {
    if (host === 'youtu.be') return s[0] && YT_ID.test(s[0]) ? ok(s[0]) : null;
    if (host !== 'youtube.com') return null;
    if (s[0] === 'watch') {
      const v = u.searchParams.get('v');
      return v && YT_ID.test(v) ? ok(v) : null;
    }
    if (s[0] === 'shorts' && s[1] && YT_ID.test(s[1])) return ok(s[1]);
    return null;
  },
  tiktok(_u, host, s) {
    if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') return s.length > 0 ? ok(null) : null;
    if (host !== 'tiktok.com') return null;
    // коротке посилання з «Поділитися» — id не видно без редиректу
    if (s[0] === 't') return s[1] ? ok(null) : null;
    if (s[0]?.startsWith('@') && s[1] === 'video' && s[2] && NUM.test(s[2])) return ok(s[2]);
    return null;
  },
  instagram(_u, host, s) {
    if (host !== 'instagram.com') return null;
    // /reel/<code> або /<користувач>/reel/<code>
    const i = IG_KINDS.includes(s[0] ?? '') ? 0 : IG_KINDS.includes(s[1] ?? '') ? 1 : -1;
    const code = i >= 0 ? s[i + 1] : undefined;
    return code && IG_CODE.test(code) ? ok(code) : null;
  },
  facebook(u, host, s) {
    if (host === 'fb.watch') return s.length > 0 ? ok(null) : null;
    if (host !== 'facebook.com') return null;
    // /share/r/<code>, /share/v/<code> — посилання «Поділитися», id не видно без редиректу
    if (s[0] === 'share' && (s[1] === 'r' || s[1] === 'v')) return s[2] ? ok(null) : null;
    if (s[0] === 'reel' && s[1] && NUM.test(s[1])) return ok(s[1]);
    if (s[0] === 'watch' && s[1] !== 'videos') {
      const v = u.searchParams.get('v');
      return v && NUM.test(v) ? ok(v) : null;
    }
    // /<сторінка>/videos/<id>, /<сторінка>/videos/<slug>/<id>, /groups/<група>/videos/<id>, /watch/videos/<id>
    const at = s.indexOf('videos');
    const videoId = at >= 0 ? s.slice(at + 1).findLast((p) => NUM.test(p)) : undefined;
    return videoId ? ok(videoId) : null;
  },
};

/** null — посилання не цієї платформи (або не посилання на пост) */
export function parsePostUrl(platform: Platform, url: string): ParsedPostUrl | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return parsers[platform](u, hostOf(u), seg(u));
}
