import { Actor, log } from 'apify';

import { facebookKey } from './facebook-url.js';
import type { Post } from './types.js';

const POSTS_ACTOR = 'apify/facebook-posts-scraper';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Pulls photo URLs out of a Facebook Posts Scraper item. Exported for tests. */
export function extractImageUrls(item: Record<string, unknown>): string[] {
    const urls: string[] = [];
    const add = (v: unknown) => {
        if (typeof v === 'string' && /^https?:\/\//.test(v) && !urls.includes(v)) urls.push(v);
    };
    const media = Array.isArray(item.media) ? item.media : [];
    for (const m of media) {
        if (!m || typeof m !== 'object') continue;
        const mm = m as Record<string, unknown>;
        const nested = (k: string) => (mm[k] && typeof mm[k] === 'object' ? (mm[k] as Record<string, unknown>).uri : undefined);
        // Prefer the full-size photo, then the thumbnail.
        add(nested('photo_image') ?? nested('image') ?? nested('photo') ?? mm.thumbnail ?? mm.url);
    }
    add(item.thumbnailUrl);
    return urls;
}

/** Maps one scraper item to a Post (or null for error/empty items). Exported for tests. */
export function itemToPost(item: Record<string, unknown>): Post | null {
    if (item.error) return null;
    const text = str(item.text) ?? '';
    const imageUrls = extractImageUrls(item);
    if (!text && imageUrls.length === 0) return null;

    let postDate: string | null = null;
    if (typeof item.timestamp === 'number') postDate = new Date(item.timestamp * 1000).toISOString();
    else if (str(item.time)) {
        const t = Date.parse(item.time as string);
        if (!Number.isNaN(t)) postDate = new Date(t).toISOString();
    }

    const user = (item.user ?? {}) as Record<string, unknown>;
    return {
        postUrl: str(item.url) ?? str(item.topLevelUrl),
        postDate,
        text,
        imageUrls,
        pageName: str(item.pageName) ?? str(user.name),
    };
}

/**
 * Scrapes recent posts for all pages in one run (one start fee) and groups them
 * by the page key we asked for.
 */
export async function scrapePosts(
    pageUrls: string[],
    opts: { postsPerPage: number; daysBack: number; maxCostUsd: number },
): Promise<Map<string, Post[]>> {
    const byPage = new Map<string, Post[]>();
    if (pageUrls.length === 0) return byPage;

    log.info(`Facebook: reading up to ${opts.postsPerPage} posts from the last ${opts.daysBack} days on ${pageUrls.length} pages`);
    const run = await Actor.call(
        POSTS_ACTOR,
        {
            startUrls: pageUrls.map((url) => ({ url })),
            resultsLimit: opts.postsPerPage,
            onlyPostsNewerThan: `${opts.daysBack} days`,
            captionText: false,
        },
        { maxTotalChargeUsd: opts.maxCostUsd },
    );
    if (run.status !== 'SUCCEEDED') {
        log.warning(`Facebook posts run ended with status ${run.status}; using whatever it collected.`);
    }

    const { items } = await Actor.apifyClient.dataset(run.defaultDatasetId).listItems({ clean: true });
    const wanted = new Set(pageUrls.map((u) => facebookKey(u)));
    let unmatched = 0;
    for (const raw of items) {
        const item = raw as Record<string, unknown>;
        const post = itemToPost(item);
        if (!post) continue;
        // inputUrl is the start URL we sent; facebookUrl is the page as Facebook resolved it.
        const key = [item.inputUrl, item.facebookUrl, item.pageUrl]
            .map((u) => facebookKey(u))
            .find((k) => k && wanted.has(k));
        if (!key) {
            unmatched++;
            continue;
        }
        const list = byPage.get(key) ?? [];
        list.push(post);
        byPage.set(key, list);
    }
    if (unmatched) log.warning(`Facebook: ${unmatched} posts could not be matched to a venue and were skipped.`);
    for (const list of byPage.values()) list.sort((a, b) => (b.postDate ?? '').localeCompare(a.postDate ?? ''));
    log.info(`Facebook: got ${items.length} items; ${byPage.size} pages had recent posts.`);
    return byPage;
}
