export interface Input {
    areas?: string[];
    areaSuffix?: string;
    searchTerms?: string[];
    maxPlacesPerSearch?: number;
    extraFacebookPages?: string[];
    venueRefreshDays?: number;
    postsPerPage?: number;
    daysBack?: number;
    geminiApiKey?: string;
    geminiModel?: string;
    geminiFallbackModels?: string[];
    geminiRequestsPerMinute?: number;
    maxImagesPerVenue?: number;
    mapsMaxCostUsd?: number;
    facebookMaxCostUsd?: number;
}

export interface Venue {
    /** Stable key: Google place ID, or the normalized Facebook URL for manual pages. */
    key: string;
    name: string;
    area: string | null;
    address: string | null;
    lat: number | null;
    lng: number | null;
    phone: string | null;
    website: string | null;
    category: string | null;
    rating: number | null;
    reviewsCount: number | null;
    googleMapsUrl: string | null;
    googlePlaceId: string | null;
    facebookUrl: string | null;
    instagramUrl: string | null;
    source: 'google_maps' | 'manual';
}

export interface Post {
    postUrl: string | null;
    postDate: string | null; // ISO timestamp
    text: string;
    imageUrls: string[];
    pageName: string | null;
}

export type SpecialKind = 'weekly_special' | 'once_off_special' | 'event';

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** One special or event found in one post. A post can hold several. */
export interface Extracted {
    postIndex: number;
    kind: SpecialKind;
    title: string;
    description: string | null;
    price: string | null;
    days: Weekday[];
    date: string | null; // YYYY-MM-DD
    startTime: string | null; // HH:MM
    endTime: string | null; // HH:MM
    validUntil: string | null; // YYYY-MM-DD
    confidence: number; // 0..1
}

/** One output row in the dataset. */
export interface OutputItem {
    id: string;
    kind: SpecialKind;
    title: string;
    description: string | null;
    price: string | null;
    days: Weekday[];
    date: string | null;
    startTime: string | null;
    endTime: string | null;
    validUntil: string | null;
    confidence: number;
    extractedBy: 'gemini' | 'keywords';
    venueKey: string;
    venueName: string;
    area: string | null;
    address: string | null;
    lat: number | null;
    lng: number | null;
    phone: string | null;
    website: string | null;
    googleMapsUrl: string | null;
    facebookUrl: string | null;
    postUrl: string | null;
    postDate: string | null;
    postText: string;
    imageUrl: string | null;
    scrapedAt: string;
}
