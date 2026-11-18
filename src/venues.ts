import { Actor, log } from 'apify';

import { facebookKey, firstFacebookPage, normalizeFacebookUrl } from './facebook-url.js';
import type { Venue } from './types.js';

const MAPS_ACTOR = 'compass/crawler-google-places';
const CACHE_STORE = 'restaurant-specials-cache';
const CACHE_KEY = 'VENUES';

interface VenueCache {
    createdAt: string;
    configKey: string;
    venues: Venue[];
}

export interface DiscoveryOptions {
    areas: string[];
    areaSuffix: string;
    searchTerms: string[];
    maxPlacesPerSearch: number;
    venueRefreshDays: number;
    mapsMaxCostUsd: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Maps one Google Maps Scraper item to a Venue. Exported for tests. */
export function placeToVenue(place: Record<string, unknown>, area: string): Venue | null {
    const name = str(place.title);
    if (!name) return null;
    if (place.permanentlyClosed === true || place.temporarilyClosed === true) return null;

    const website = str(place.website);
    const location = (place.location ?? {}) as Record<string, unknown>;
    // The venue's "website" on Google Maps is often its Facebook page.
    const facebookUrl = firstFacebookPage([website, ...arr(place.facebooks)]);
    const instagram = arr(place.instagrams).find((u) => typeof u === 'string') as string | undefined;
    const placeId = str(place.placeId);

    return {
        key: placeId ?? `maps:${name.toLowerCase()}|${str(place.address) ?? ''}`,
        name,
        area,
        address: str(place.address),
        lat: num(location.lat),
        lng: num(location.lng),
        phone: str(place.phone) ?? str(place.phoneUnformatted),
        website: website && !normalizeFacebookUrl(website) ? website : null,
        category: str(place.categoryName),
        rating: num(place.totalScore),
        reviewsCount: num(place.reviewsCount),
        googleMapsUrl: str(place.url),
        googlePlaceId: placeId,
        facebookUrl,
        instagramUrl: instagram ?? null,
        source: 'google_maps',
    };
}

function configKeyFor(o: DiscoveryOptions): string {
    return JSON.stringify({
        areas: [...o.areas].map((a) => a.toLowerCase()).sort(),
        suffix: o.areaSuffix.toLowerCase(),
        terms: [...o.searchTerms].map((t) => t.toLowerCase()).sort(),
        max: o.maxPlacesPerSearch,
    });
}

async function searchArea(area: string, o: DiscoveryOptions, costCap: number): Promise<Venue[]> {
    const locationQuery = o.areaSuffix ? `${area}, ${o.areaSuffix}` : area;
    log.info(`Google Maps: searching "${o.searchTerms.join('", "')}" in ${locationQuery}`);
    const run = await Actor.call(
        MAPS_ACTOR,
        {
            searchStringsArray: o.searchTerms,
            locationQuery,
            maxCrawledPlacesPerSearch: o.maxPlacesPerSearch,
            language: 'en',
            // Reads each venue's website for social links (cheap add-on), so we can find their Facebook page.
            scrapeContacts: true,
        },
        { maxTotalChargeUsd: costCap },
    );
    if (run.status !== 'SUCCEEDED') {
        log.warning(`Google Maps run for ${area} ended with status ${run.status}; using whatever it collected.`);
    }
    const { items } = await Actor.apifyClient.dataset(run.defaultDatasetId).listItems({ clean: true });
    const venues = items
        .map((p) => placeToVenue(p as Record<string, unknown>, area))
        .filter((v): v is Venue => v !== null);
    log.info(`Google Maps: ${venues.length} open venues in ${area}, ${venues.filter((v) => v.facebookUrl).length} with a Facebook page`);
    return venues;
}

/** Returns Google Maps venues, from cache when it's fresh enough. */
export async function discoverMapsVenues(o: DiscoveryOptions): Promise<{ venues: Venue[]; fromCache: boolean }> {
    if (o.areas.length === 0 || o.searchTerms.length === 0) return { venues: [], fromCache: false };

    const store = await Actor.openKeyValueStore(CACHE_STORE);
    const configKey = configKeyFor(o);
    const cached = await store.getValue<VenueCache>(CACHE_KEY);
    if (cached && o.venueRefreshDays > 0 && cached.configKey === configKey) {
        const ageDays = (Date.now() - Date.parse(cached.createdAt)) / 86_400_000;
        if (ageDays < o.venueRefreshDays) {
            log.info(`Using ${cached.venues.length} cached venues from ${cached.createdAt} (refresh every ${o.venueRefreshDays} days).`);
            return { venues: cached.venues, fromCache: true };
        }
    }

    const perAreaCap = Math.max(0.1, o.mapsMaxCostUsd / o.areas.length);
    const byKey = new Map<string, Venue>();
    for (const area of o.areas) {
        await Actor.setStatusMessage(`Finding venues on Google Maps: ${area}`);
        try {
            for (const v of await searchArea(area, o, perAreaCap)) {
                if (!byKey.has(v.key)) byKey.set(v.key, v);
            }
        } catch (err) {
            log.warning(`Google Maps search failed for ${area}: ${(err as Error).message}`);
        }
    }
    const venues = [...byKey.values()];
    await store.setValue(CACHE_KEY, { createdAt: new Date().toISOString(), configKey, venues } satisfies VenueCache);
    return { venues, fromCache: false };
}

/** Adds manual Facebook pages, skipping any already found via Google Maps. */
export function mergeManualPages(venues: Venue[], pages: string[]): Venue[] {
    const seen = new Set(venues.map((v) => facebookKey(v.facebookUrl)).filter(Boolean));
    const out = [...venues];
    for (const raw of pages) {
        const url = normalizeFacebookUrl(raw);
        if (!url) {
            log.warning(`Skipping extra Facebook page that isn't a page URL: ${raw}`);
            continue;
        }
        const key = facebookKey(url)!;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            key: `fb:${key}`,
            name: url, // replaced by the page name once posts come back
            area: null,
            address: null,
            lat: null,
            lng: null,
            phone: null,
            website: null,
            category: null,
            rating: null,
            reviewsCount: null,
            googleMapsUrl: null,
            googlePlaceId: null,
            facebookUrl: url,
            instagramUrl: null,
            source: 'manual',
        });
    }
    return out;
}
