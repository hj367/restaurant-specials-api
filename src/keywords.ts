import { WEEKDAYS } from './types.js';
import type { Extracted, Post, Weekday } from './types.js';

/** Fallback when there's no Gemini key or Gemini fails: simple English/Afrikaans keyword rules. */

const EVENT_WORDS = [
    'karaoke', 'quiz', 'trivia', 'live music', 'live band', 'live entertainment', 'dj ', ' dj', 'rugby', 'springbok',
    'bokke', 'soccer', 'football', 'cricket', 'match', 'game day', 'screening', 'big screen', 'comedy', 'open mic',
    'band', 'gig', 'market', 'braai', 'fundraiser', 'ladies night', "ladies' night", 'musiek', 'wedstryd',
];
const SPECIAL_WORDS = [
    'special', 'specials', 'spesiaal', 'spesiale', 'aanbieding', 'happy hour', 'half price', 'half-price', 'halfprys',
    '2 for 1', '2-for-1', '2for1', 'two for one', 'buy one get one', 'bogof', '% off', 'discount', 'deal', 'combo',
    'only r', 'slegs r', 'promo', 'bottomless', 'unlimited', 'free ',
];
const RECURRING_WORDS = ['every ', 'elke ', 'weekly', 'weekliks', 'daily', 'daagliks', 'each '];

const AFRIKAANS_DAYS: Record<string, Weekday> = {
    maandag: 'Monday', dinsdag: 'Tuesday', woensdag: 'Wednesday', donderdag: 'Thursday',
    vrydag: 'Friday', saterdag: 'Saturday', sondag: 'Sunday',
};

function findDays(lower: string): Weekday[] {
    const days = new Set<Weekday>();
    for (const d of WEEKDAYS) {
        if (new RegExp(`\\b${d.toLowerCase()}s?\\b`).test(lower) || new RegExp(`\\b${d.slice(0, 3).toLowerCase()}\\b`).test(lower)) {
            days.add(d);
        }
    }
    for (const [af, en] of Object.entries(AFRIKAANS_DAYS)) if (lower.includes(af)) days.add(en);
    return WEEKDAYS.filter((d) => days.has(d));
}

export function classifyByKeywords(post: Post, postIndex: number): Extracted | null {
    const text = post.text;
    if (!text) return null;
    const lower = ` ${text.toLowerCase()} `;
    const priceMatch = text.match(/\bR\s?\d{1,4}(?:[.,]\d{2})?\b/);
    const isEvent = EVENT_WORDS.some((w) => lower.includes(w));
    const isSpecial = !!priceMatch || SPECIAL_WORDS.some((w) => lower.includes(w));
    if (!isEvent && !isSpecial) return null;

    const days = findDays(lower);
    const recurring = RECURRING_WORDS.some((w) => lower.includes(w)) || /\b(mon|tues|wednes|thurs|fri|satur|sun)days\b/.test(lower);
    const kind: Extracted['kind'] = isEvent && !priceMatch ? 'event' : recurring && days.length ? 'weekly_special' : isEvent ? 'event' : 'once_off_special';

    const firstLine = text.split(/\n+/).map((l) => l.trim()).find(Boolean) ?? text;
    return {
        postIndex,
        kind,
        title: firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine,
        description: text.length > 200 ? `${text.slice(0, 197)}...` : text,
        price: priceMatch ? priceMatch[0].replace(/\s/g, '') : null,
        days,
        date: null,
        startTime: null,
        endTime: null,
        validUntil: null,
        confidence: 0.4,
    };
}
