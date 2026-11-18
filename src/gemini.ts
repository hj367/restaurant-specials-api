import { log } from 'apify';

import { WEEKDAYS } from './types.js';
import type { Extracted, Post, SpecialKind, Venue, Weekday } from './types.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const KINDS: SpecialKind[] = ['weekly_special', 'once_off_special', 'event'];

/** Thrown when the key's daily quota is used up: the caller switches to keywords for the rest of the run. */
export class GeminiQuotaExhausted extends Error {}

const RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
        items: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    postIndex: { type: 'INTEGER', description: 'The POST number this came from.' },
                    kind: { type: 'STRING', enum: KINDS },
                    title: { type: 'STRING', description: 'Short title, max 60 characters, in English.' },
                    description: { type: 'STRING', description: 'Details and conditions, max 200 characters, in English.' },
                    price: { type: 'STRING', nullable: true, description: "Price as written, e.g. 'R89' or 'R120 for 2'." },
                    days: { type: 'ARRAY', items: { type: 'STRING', enum: [...WEEKDAYS] } },
                    date: { type: 'STRING', nullable: true, description: 'YYYY-MM-DD for a once-off special or event.' },
                    startTime: { type: 'STRING', nullable: true, description: 'HH:MM, 24-hour.' },
                    endTime: { type: 'STRING', nullable: true, description: 'HH:MM, 24-hour.' },
                    validUntil: { type: 'STRING', nullable: true, description: 'YYYY-MM-DD, last day the offer runs.' },
                    confidence: { type: 'NUMBER', description: '0 to 1: how sure you are this is a real, current special/event.' },
                },
                required: ['postIndex', 'kind', 'title', 'days', 'confidence'],
            },
        },
    },
    required: ['items'],
};

function todayInSouthAfrica(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());
}

function buildPrompt(venue: Venue): string {
    return [
        `You read Facebook posts from "${venue.name}"${venue.area ? `, a restaurant/bar in ${venue.area}` : ''}, Cape Town, South Africa.`,
        `Today is ${todayInSouthAfrica()} (South African time).`,
        'Find every special or event the posts advertise and return one item per special/event (a post can contain several):',
        '- weekly_special: a recurring offer, e.g. "every Tuesday", "Mon-Fri", happy hour, a standing lunch special.',
        '- once_off_special: a limited-time offer tied to dates or an occasion, e.g. Black Friday, Valentine\'s Day, "this weekend only".',
        '- event: something happening at the venue, e.g. live rugby/soccer/cricket on the big screen, karaoke, quiz night, live music, DJ, comedy, markets.',
        'Ignore posts that only advertise the venue in general, job adverts, closures, thank-you posts, or photos without a specific offer or event.',
        'Many specials are only written on the poster, so read the text in the photos too.',
        'Posts may be in Afrikaans: write title and description in English.',
        'days: weekdays the special/event applies to (empty if not stated). date: the specific date for a once-off special or event;',
        'resolve words like "this Friday" or "tonight" against the post date. validUntil: the last date if one is stated.',
        'Only use details that are in the post or photo. Never invent prices, dates or times. Return {"items": []} if nothing qualifies.',
    ].join('\n');
}

async function fetchImage(url: string): Promise<{ mimeType: string; data: string } | null> {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) return null;
        const mimeType = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim();
        if (!mimeType.startsWith('image/')) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
        return { mimeType, data: buf.toString('base64') };
    } catch {
        return null;
    }
}

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

async function buildParts(venue: Venue, posts: Post[], maxImages: number): Promise<Part[]> {
    const parts: Part[] = [{ text: buildPrompt(venue) }];
    let imagesLeft = maxImages;
    for (let i = 0; i < posts.length; i++) {
        const p = posts[i];
        parts.push({ text: `\nPOST ${i} (posted ${p.postDate?.slice(0, 10) ?? 'unknown date'}):\n${p.text || '(no text, photo only)'}` });
        if (imagesLeft > 0 && p.imageUrls[0]) {
            const img = await fetchImage(p.imageUrls[0]);
            if (img) {
                parts.push({ text: `Photo from POST ${i}:` }, { inlineData: img });
                imagesLeft--;
            }
        }
    }
    return parts;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

const optStr = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const optDate = (v: unknown): string | null => (typeof v === 'string' && DATE_RE.test(v.trim()) ? v.trim() : null);
const optTime = (v: unknown): string | null => {
    if (typeof v !== 'string' || !TIME_RE.test(v.trim())) return null;
    const [h, m] = v.trim().split(':');
    return `${h.padStart(2, '0')}:${m}`;
};

/** Validates Gemini's JSON against what we asked for. Exported for tests. */
export function parseGeminiItems(json: unknown, postCount: number): Extracted[] {
    const items = (json as { items?: unknown })?.items;
    if (!Array.isArray(items)) return [];
    const out: Extracted[] = [];
    for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        const postIndex = typeof r.postIndex === 'number' ? Math.trunc(r.postIndex) : -1;
        if (postIndex < 0 || postIndex >= postCount) continue;
        if (!KINDS.includes(r.kind as SpecialKind)) continue;
        const title = optStr(r.title, 80);
        if (!title) continue;
        const days = Array.isArray(r.days) ? WEEKDAYS.filter((d) => (r.days as unknown[]).includes(d)) : [];
        const conf = typeof r.confidence === 'number' ? Math.min(1, Math.max(0, r.confidence)) : 0.5;
        out.push({
            postIndex,
            kind: r.kind as SpecialKind,
            title,
            description: optStr(r.description, 300),
            price: optStr(r.price, 60),
            days: days as Weekday[],
            date: optDate(r.date),
            startTime: optTime(r.startTime),
            endTime: optTime(r.endTime),
            validUntil: optDate(r.validUntil),
            confidence: Math.round(conf * 100) / 100,
        });
    }
    return out;
}

/** Reads Google's RetryInfo ("30s") from an error body, in ms. */
function retryDelayMs(body: unknown): number | null {
    const details = (body as { error?: { details?: unknown[] } })?.error?.details;
    if (!Array.isArray(details)) return null;
    for (const d of details) {
        const delay = (d as { retryDelay?: string })?.retryDelay;
        if (typeof delay === 'string') {
            const s = Number.parseFloat(delay);
            if (Number.isFinite(s)) return Math.ceil(s * 1000);
        }
    }
    return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Extractor {
    readonly model: string;
    extract(venue: Venue, posts: Post[]): Promise<Extracted[]>;
}

/**
 * Tries models in order. Each Gemini model has its own free daily quota, so when one
 * runs out we move on to the next instead of dropping straight to keywords.
 */
export class GeminiPool {
    private index = 0;

    constructor(private readonly clients: Extractor[]) {}

    get exhausted(): boolean {
        return this.index >= this.clients.length;
    }

    /** Returns null once every model's daily quota is used up. */
    async extract(venue: Venue, posts: Post[]): Promise<{ items: Extracted[]; model: string } | null> {
        while (this.index < this.clients.length) {
            const client = this.clients[this.index];
            try {
                return { items: await client.extract(venue, posts), model: client.model };
            } catch (err) {
                if (!(err instanceof GeminiQuotaExhausted)) throw err;
                this.index++;
                const next = this.clients[this.index]?.model;
                log.warning(`Gemini ${client.model}: daily free quota used up${next ? `; switching to ${next}` : ''}.`);
            }
        }
        return null;
    }
}

export class GeminiClient implements Extractor {
    private nextSlot = 0;
    private readonly minIntervalMs: number;

    constructor(
        private readonly apiKey: string,
        readonly model: string,
        requestsPerMinute: number,
        private readonly maxImages: number,
    ) {
        this.minIntervalMs = Math.ceil(60_000 / Math.max(1, requestsPerMinute));
    }

    private async waitForSlot() {
        const now = Date.now();
        const wait = this.nextSlot - now;
        this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
        if (wait > 0) await sleep(wait);
    }

    /** Sends one venue's recent posts (with photos) and returns the specials/events found. */
    async extract(venue: Venue, posts: Post[]): Promise<Extracted[]> {
        let parts = await buildParts(venue, posts, this.maxImages);
        const url = `${API_BASE}/${encodeURIComponent(this.model)}:generateContent`;

        for (let attempt = 1; attempt <= 5; attempt++) {
            await this.waitForSlot();
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts }],
                    generationConfig: {
                        responseMimeType: 'application/json',
                        responseSchema: RESPONSE_SCHEMA,
                        temperature: 0.1,
                    },
                }),
                signal: AbortSignal.timeout(120_000),
            }).catch((err: Error) => err);

            if (res instanceof Error) {
                log.warning(`Gemini request failed for ${venue.name} (attempt ${attempt}): ${res.message}`);
                await sleep(2_000 * attempt);
                continue;
            }

            const body: unknown = await res.json().catch(() => null);
            if (res.ok) {
                const text = (body as { candidates?: { content?: { parts?: { text?: string }[] } }[] })?.candidates?.[0]?.content?.parts
                    ?.map((p) => p.text ?? '')
                    .join('');
                if (!text) return [];
                try {
                    return parseGeminiItems(JSON.parse(text), posts.length);
                } catch {
                    log.warning(`Gemini returned invalid JSON for ${venue.name}; skipping its posts.`);
                    return [];
                }
            }

            const message = (body as { error?: { message?: string } })?.error?.message ?? res.statusText;
            if (res.status === 429) {
                // The quota ID in the error details says which limit was hit, e.g. "...RequestsPerDayPerProjectPerModel-FreeTier".
                if (/PerDay|per day|daily/i.test(`${message} ${JSON.stringify(body)}`)) throw new GeminiQuotaExhausted(message);
                const delay = retryDelayMs(body) ?? 15_000 * attempt;
                log.info(`Gemini rate limit hit; waiting ${Math.round(delay / 1000)}s.`);
                await sleep(delay);
                continue;
            }
            if (res.status >= 500) {
                await sleep(3_000 * attempt);
                continue;
            }
            if (res.status === 400 && parts.some((p) => 'inlineData' in p)) {
                // Usually an image Gemini can't read: retry once with text only.
                log.warning(`Gemini rejected a photo for ${venue.name} (${message}); retrying with text only.`);
                parts = parts.filter((p) => !('inlineData' in p) && !(('text' in p) && p.text.startsWith('Photo from POST')));
                continue;
            }
            throw new Error(`Gemini ${res.status}: ${message}`);
        }
        throw new Error('Gemini kept failing after 5 attempts');
    }
}
