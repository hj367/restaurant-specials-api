/**
 * Helpers for turning the many shapes of Facebook links found on websites and
 * Google Maps into one canonical page URL.
 */

const FB_HOSTS = /(^|\.)(facebook\.com|fb\.com)$/i;

/** First path segments that are never a venue's own page. */
const NON_PAGE_SEGMENTS = new Set([
    'sharer', 'sharer.php', 'share', 'share.php', 'plugins', 'dialog', 'tr', 'events', 'groups', 'photo',
    'photo.php', 'photos', 'watch', 'hashtag', 'login', 'login.php', 'policies', 'policy.php', 'help', 'privacy',
    'legal', 'terms', 'ads', 'business', 'marketplace', 'gaming', 'stories', 'reel', 'reels', 'story.php',
    'permalink.php', 'home.php', 'search', 'l.php', 'media', 'notes', 'video.php', 'videos', 'fundraisers',
]);

/**
 * Returns a canonical page URL (https://www.facebook.com/<page>/ or
 * https://www.facebook.com/profile.php?id=<id>) or null if the link is not a page.
 */
export function normalizeFacebookUrl(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    let s = raw.trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;

    let url: URL;
    try {
        url = new URL(s);
    } catch {
        return null;
    }
    if (!FB_HOSTS.test(url.hostname)) return null;

    const segments = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
    if (segments.length === 0) return null;
    const first = segments[0].toLowerCase();

    if (first === 'profile.php') {
        const id = url.searchParams.get('id');
        return id && /^\d+$/.test(id) ? `https://www.facebook.com/profile.php?id=${id}` : null;
    }
    // New-style profile pages: /p/Venue-Name-100012345678/
    if (first === 'p' && segments[1]) return `https://www.facebook.com/p/${segments[1]}/`;
    // Old-style: /pages/Venue-Name/123456789
    if (first === 'pages') {
        if (segments[1] && segments[2] && /^\d+$/.test(segments[2])) {
            return `https://www.facebook.com/pages/${segments[1]}/${segments[2]}/`;
        }
        return null;
    }
    // /pg/VenueName/posts -> /VenueName/
    const slug = first === 'pg' ? segments[1] : segments[0];
    if (!slug) return null;
    if (NON_PAGE_SEGMENTS.has(slug.toLowerCase())) return null;
    if (!/^[\w.\-]+$/u.test(slug)) return null;
    return `https://www.facebook.com/${slug}/`;
}

/** Key used to match scraper output back to the URL we asked for. */
export function facebookKey(raw: unknown): string | null {
    const n = normalizeFacebookUrl(raw);
    return n ? n.toLowerCase().replace(/\/+$/, '') : null;
}

/** Picks the first usable page URL from a list of candidates. */
export function firstFacebookPage(candidates: unknown[]): string | null {
    for (const c of candidates) {
        const n = normalizeFacebookUrl(c);
        if (n) return n;
    }
    return null;
}
