import type { Platform } from '@vf/shared';

export interface ParsedPostUrl {
  platformPostId: string | null;
}

const hostOf = (u: URL) => u.hostname.toLowerCase().replace(/^(www|m)\./, '');
const seg = (u: URL) => u.pathname.split('/').filter(Boolean);
const ok = (id: string | null | undefined): ParsedPostUrl => ({ platformPostId: id ?? null });

const YT_ID = /^[\w-]{11}$/;
const NUM = /^\d+$/;
const IG_CODE = /^[\w-]+$/;

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
    if (s[0]?.startsWith('@') && s[1] === 'video' && s[2] && NUM.test(s[2])) return ok(s[2]);
    return null;
  },
  instagram(_u, host, s) {
    if (host !== 'instagram.com') return null;
    if (['reel', 'reels', 'p'].includes(s[0] ?? '') && s[1] && IG_CODE.test(s[1])) return ok(s[1]);
    return null;
  },
  facebook(u, host, s) {
    if (host === 'fb.watch') return s.length > 0 ? ok(null) : null;
    if (host !== 'facebook.com') return null;
    if (s[0] === 'reel' && s[1] && NUM.test(s[1])) return ok(s[1]);
    if (s[0] === 'watch') {
      const v = u.searchParams.get('v');
      return v && NUM.test(v) ? ok(v) : null;
    }
    if (s[1] === 'videos' && s[2] && NUM.test(s[2])) return ok(s[2]);
    return null;
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
