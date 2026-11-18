import assert from 'node:assert/strict';
import { test } from 'node:test';

import { facebookKey, normalizeFacebookUrl } from '../src/facebook-url.js';
import { GeminiPool, GeminiQuotaExhausted, parseGeminiItems } from '../src/gemini.js';
import type { Extracted, Venue } from '../src/types.js';
import { classifyByKeywords } from '../src/keywords.js';
import { extractImageUrls, itemToPost } from '../src/posts.js';
import { mergeManualPages, placeToVenue } from '../src/venues.js';

test('normalizeFacebookUrl keeps pages and drops non-pages', () => {
    assert.equal(normalizeFacebookUrl('https://m.facebook.com/CornerDeck/?ref=page'), 'https://www.facebook.com/CornerDeck/');
    assert.equal(normalizeFacebookUrl('facebook.com/CornerDeck'), 'https://www.facebook.com/CornerDeck/');
    assert.equal(normalizeFacebookUrl('https://web.facebook.com/pg/CornerDeck/posts/'), 'https://www.facebook.com/CornerDeck/');
    assert.equal(normalizeFacebookUrl('https://www.facebook.com/profile.php?id=100063612345678&sk=about'), 'https://www.facebook.com/profile.php?id=100063612345678');
    assert.equal(normalizeFacebookUrl('https://www.facebook.com/p/Some-Pub-100089999/'), 'https://www.facebook.com/p/Some-Pub-100089999/');
    assert.equal(normalizeFacebookUrl('https://www.facebook.com/sharer/sharer.php?u=x'), null);
    assert.equal(normalizeFacebookUrl('https://www.facebook.com/events/123'), null);
    assert.equal(normalizeFacebookUrl('https://www.facebook.com/'), null);
    assert.equal(normalizeFacebookUrl('https://instagram.com/cornerdeck'), null);
    assert.equal(normalizeFacebookUrl(undefined), null);
    assert.equal(facebookKey('https://www.facebook.com/CornerDeck/'), facebookKey('http://facebook.com/cornerdeck'));
});

test('placeToVenue uses a Facebook "website" and skips closed places', () => {
    const v = placeToVenue(
        {
            title: 'Corner Deck', placeId: 'ChIJabc', address: '1 Main Rd, Brackenfell', website: 'https://www.facebook.com/CornerDeck',
            location: { lat: -33.87, lng: 18.69 }, categoryName: 'Bar', totalScore: 4.5, reviewsCount: 120, url: 'https://maps.google.com/?cid=1',
        },
        'Brackenfell',
    );
    assert.ok(v);
    assert.equal(v.facebookUrl, 'https://www.facebook.com/CornerDeck/');
    assert.equal(v.website, null);
    assert.equal(v.key, 'ChIJabc');

    const v2 = placeToVenue({ title: 'Pub', website: 'https://pub.co.za', facebooks: ['https://www.facebook.com/sharer.php', 'https://facebook.com/ThePub'] }, 'Bellville');
    assert.equal(v2?.facebookUrl, 'https://www.facebook.com/ThePub/');
    assert.equal(v2?.website, 'https://pub.co.za');

    assert.equal(placeToVenue({ title: 'Gone', permanentlyClosed: true }, 'Parow'), null);
});

test('mergeManualPages skips duplicates and bad URLs', () => {
    const maps = [placeToVenue({ title: 'Corner Deck', placeId: 'x', website: 'https://facebook.com/CornerDeck' }, 'Brackenfell')!];
    const merged = mergeManualPages(maps, ['https://www.facebook.com/cornerdeck/', 'https://www.facebook.com/NewPlace', 'not a url']);
    assert.equal(merged.length, 2);
    assert.equal(merged[1].facebookUrl, 'https://www.facebook.com/NewPlace/');
    assert.equal(merged[1].source, 'manual');
});

test('itemToPost reads text, date and photos', () => {
    const post = itemToPost({
        url: 'https://www.facebook.com/CornerDeck/posts/1', timestamp: 1763452800, text: 'Taco Tuesday R25',
        media: [{ photo_image: { uri: 'https://scontent.fbcdn.net/a.jpg' }, thumbnail: 'https://scontent.fbcdn.net/a_t.jpg' }],
        pageName: 'Corner Deck',
    });
    assert.ok(post);
    assert.equal(post.postDate, new Date(1763452800 * 1000).toISOString());
    assert.deepEqual(post.imageUrls, ['https://scontent.fbcdn.net/a.jpg']);
    assert.equal(itemToPost({ error: 'not found', url: 'x' }), null);
    assert.deepEqual(extractImageUrls({ media: [{ thumbnail: 'https://x/t.jpg' }] }), ['https://x/t.jpg']);
});

test('classifyByKeywords finds weekly specials and events', () => {
    const base = { postUrl: null, postDate: null, imageUrls: [], pageName: null };
    const weekly = classifyByKeywords({ ...base, text: 'Every Tuesday: burger & chips only R89!' }, 0);
    assert.equal(weekly?.kind, 'weekly_special');
    assert.deepEqual(weekly?.days, ['Tuesday']);
    assert.equal(weekly?.price, 'R89');

    const event = classifyByKeywords({ ...base, text: 'Kom kyk die Bokke op die big screen hierdie Saterdag!' }, 1);
    assert.equal(event?.kind, 'event');
    assert.deepEqual(event?.days, ['Saturday']);

    assert.equal(classifyByKeywords({ ...base, text: 'Thank you to everyone who came out last night' }, 2), null);
});

test('parseGeminiItems validates the model output', () => {
    const items = parseGeminiItems(
        {
            items: [
                { postIndex: 0, kind: 'weekly_special', title: 'Taco Tuesday', price: 'R25', days: ['Tuesday', 'Funday'], startTime: '17:00', confidence: 0.92 },
                { postIndex: 5, kind: 'event', title: 'Out of range', days: [], confidence: 1 },
                { postIndex: 1, kind: 'party', title: 'Bad kind', days: [], confidence: 1 },
                { postIndex: 1, kind: 'event', title: 'Rugby on the big screen', days: [], date: '2026-11-22', startTime: '9:30', confidence: 2 },
            ],
        },
        2,
    );
    assert.equal(items.length, 2);
    assert.deepEqual(items[0].days, ['Tuesday']);
    assert.equal(items[1].startTime, '09:30');
    assert.equal(items[1].confidence, 1);
    assert.equal(items[1].date, '2026-11-22');
    assert.deepEqual(parseGeminiItems(null, 2), []);
});

test('GeminiPool moves to the next model when a daily quota runs out', async () => {
    const item: Extracted = {
        postIndex: 0, kind: 'event', title: 'Quiz night', description: null, price: null, days: ['Wednesday'],
        date: null, startTime: null, endTime: null, validUntil: null, confidence: 0.9,
    };
    const calls: string[] = [];
    const quotaOut = (model: string) => ({ model, extract: async () => { calls.push(model); throw new GeminiQuotaExhausted('per day'); } });
    const works = (model: string) => ({ model, extract: async () => { calls.push(model); return [item]; } });
    const venue = { name: 'Test' } as Venue;

    const pool = new GeminiPool([quotaOut('a'), works('b'), works('c')]);
    assert.deepEqual(await pool.extract(venue, []), { items: [item], model: 'b' });
    assert.deepEqual(await pool.extract(venue, []), { items: [item], model: 'b' });
    assert.deepEqual(calls, ['a', 'b', 'b']); // 'a' is not retried once it's out

    const dead = new GeminiPool([quotaOut('x'), quotaOut('y')]);
    assert.equal(await dead.extract(venue, []), null);
    assert.equal(dead.exhausted, true);

    const failing = new GeminiPool([{ model: 'z', extract: async () => { throw new Error('boom'); } }]);
    await assert.rejects(failing.extract(venue, []), /boom/);
    assert.equal(failing.exhausted, false); // ordinary errors don't burn the model
});
