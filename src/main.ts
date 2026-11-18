import { createHash } from 'node:crypto';

import { Actor, log } from 'apify';

import { facebookKey } from './facebook-url.js';
import { GeminiClient, GeminiQuotaExhausted } from './gemini.js';
import { classifyByKeywords } from './keywords.js';
import { scrapePosts } from './posts.js';
import type { Extracted, Input, OutputItem, Post, Venue } from './types.js';
import { discoverMapsVenues, mergeManualPages } from './venues.js';

await Actor.init();

const input = (await Actor.getInput<Input>()) ?? {};
const clean = (list?: string[]) => (list ?? []).map((s) => s.trim()).filter(Boolean);

const areas = clean(input.areas);
const searchTerms = clean(input.searchTerms);
const extraPages = clean(input.extraFacebookPages);
const postsPerPage = input.postsPerPage ?? 5;
const daysBack = input.daysBack ?? 14;
const scrapedAt = new Date().toISOString();

if (areas.length === 0 && extraPages.length === 0) {
    await Actor.fail('Add at least one area or one extra Facebook page.');
}

// 1. Venues: Google Maps (cached) + your own Facebook pages.
const { venues: mapsVenues, fromCache } = await discoverMapsVenues({
    areas,
    areaSuffix: input.areaSuffix?.trim() ?? 'South Africa',
    searchTerms,
    maxPlacesPerSearch: input.maxPlacesPerSearch ?? 20,
    venueRefreshDays: input.venueRefreshDays ?? 30,
    mapsMaxCostUsd: input.mapsMaxCostUsd ?? 3,
});
const venues = mergeManualPages(mapsVenues, extraPages);
const withFacebook = venues.filter((v) => v.facebookUrl);
log.info(`${venues.length} venues in total, ${withFacebook.length} with a Facebook page.`);

// 2. Recent Facebook posts for every venue with a page, in one scraper run.
await Actor.setStatusMessage(`Reading Facebook posts for ${withFacebook.length} venues`);
const postsByPage = await scrapePosts(
    withFacebook.map((v) => v.facebookUrl!),
    { postsPerPage, daysBack, maxCostUsd: input.facebookMaxCostUsd ?? 5 },
);

// Manual pages only have a URL until their posts tell us the page name.
for (const v of withFacebook) {
    if (v.source !== 'manual') continue;
    const name = postsByPage.get(facebookKey(v.facebookUrl)!)?.find((p) => p.pageName)?.pageName;
    if (name) v.name = name;
}

// 3. Pull specials/events out of each venue's posts.
const gemini = input.geminiApiKey?.trim()
    ? new GeminiClient(input.geminiApiKey.trim(), input.geminiModel?.trim() || 'gemini-3.8-flash', input.geminiRequestsPerMinute ?? 8, input.maxImagesPerVenue ?? 4)
    : null;
if (!gemini) log.warning('No Gemini API key: using the keyword filter, which misses specials that are only in photos.');

let geminiAvailable = gemini !== null;
const stats = { venuesWithPosts: 0, posts: 0, found: 0, byGemini: 0, byKeywords: 0, geminiErrors: 0 };

function makeItem(venue: Venue, post: Post, x: Extracted, extractedBy: OutputItem['extractedBy']): OutputItem {
    const id = createHash('sha1').update(`${post.postUrl ?? venue.key + post.postDate}|${x.kind}|${x.title.toLowerCase()}`).digest('hex').slice(0, 16);
    const { postIndex: _postIndex, ...details } = x;
    return {
        id,
        ...details,
        extractedBy,
        venueKey: venue.key,
        venueName: venue.name,
        area: venue.area,
        address: venue.address,
        lat: venue.lat,
        lng: venue.lng,
        phone: venue.phone,
        website: venue.website,
        googleMapsUrl: venue.googleMapsUrl,
        facebookUrl: venue.facebookUrl,
        postUrl: post.postUrl,
        postDate: post.postDate,
        postText: post.text,
        imageUrl: post.imageUrls[0] ?? null,
        scrapedAt,
    } as OutputItem;
}

let done = 0;
for (const venue of withFacebook) {
    const posts = postsByPage.get(facebookKey(venue.facebookUrl)!) ?? [];
    if (posts.length === 0) continue;
    stats.venuesWithPosts++;
    stats.posts += posts.length;
    done++;
    if (done % 5 === 0) await Actor.setStatusMessage(`Reading posts: ${done} venues done`);

    let extracted: Extracted[] | null = null;
    let by: OutputItem['extractedBy'] = 'keywords';
    if (gemini && geminiAvailable) {
        try {
            extracted = await gemini.extract(venue, posts);
            by = 'gemini';
        } catch (err) {
            if (err instanceof GeminiQuotaExhausted) {
                geminiAvailable = false;
                log.warning(`Gemini daily quota used up; switching to the keyword filter for the remaining venues. (${err.message})`);
            } else {
                stats.geminiErrors++;
                log.warning(`Gemini failed for ${venue.name}: ${(err as Error).message}. Using keywords for this venue.`);
            }
        }
    }
    if (extracted === null) {
        extracted = posts.map((p, i) => classifyByKeywords(p, i)).filter((x): x is Extracted => x !== null);
        by = 'keywords';
    }

    const items = extracted.map((x) => makeItem(venue, posts[x.postIndex], x, by));
    if (items.length) await Actor.pushData(items);
    stats.found += items.length;
    if (by === 'gemini') stats.byGemini += items.length;
    else stats.byKeywords += items.length;
}

// 4. Venue list (including venues without Facebook) for importing into Dop & Dine.
await Actor.setValue('VENUES', venues);
const summary = {
    scrapedAt,
    venues: venues.length,
    venuesWithFacebook: withFacebook.length,
    venuesFromCache: fromCache,
    ...stats,
    geminiModel: gemini ? input.geminiModel?.trim() || 'gemini-3.8-flash' : null,
};
await Actor.setValue('SUMMARY', summary);
log.info('Done', summary);
await Actor.exit(`Found ${stats.found} specials/events from ${stats.venuesWithPosts} venues with recent posts (${venues.length} venues checked).`);
