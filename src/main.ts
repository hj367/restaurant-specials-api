import http from 'node:http';
import { Actor } from 'apify';

await Actor.init();

const MAPS_ACTOR = 'compass/crawler-google-places';
const FB_ACTOR = 'apify/facebook-posts-scraper';

interface RestaurantsQuery {
    area: string;
    limit?: number;
    postsPerPage?: number;
}

async function findRestaurants(area: string, limit: number) {
    const run = await Actor.call(MAPS_ACTOR, {
        searchStringsArray: ['restaurant'],
        locationQuery: area,
        maxCrawledPlacesPerSearch: limit,
        scrapeContacts: false,
        scrapeSocialMediaProfiles: { facebooks: true },
    }, { waitSecs: 600 });
    if (run.status !== 'SUCCEEDED') throw new Error(`Maps run ${run.id} ended with ${run.status}`);
    const dataset = await Actor.apifyClient.dataset(run.defaultDatasetId!).listItems();
    return dataset.items as any[];
}

async function fetchFacebookPosts(pageUrls: string[], postsPerPage: number) {
    if (pageUrls.length === 0) return [];
    const run = await Actor.call(FB_ACTOR, {
        startUrls: pageUrls.map((url) => ({ url })),
        resultsLimit: postsPerPage,
    }, { waitSecs: 600 });
    if (run.status !== 'SUCCEEDED') throw new Error(`Facebook run ${run.id} ended with ${run.status}`);
    const dataset = await Actor.apifyClient.dataset(run.defaultDatasetId!).listItems();
    return dataset.items as any[];
}

async function handleSearch(query: RestaurantsQuery) {
    const limit = query.limit ?? 25;
    const postsPerPage = query.postsPerPage ?? 10;

    const places = await findRestaurants(query.area, limit);

    // Keep the Facebook page URL for each restaurant when Google Maps lists one
    const withFacebook = places.filter((p) => typeof p.facebookUrl === 'string' && p.facebookUrl.includes('facebook.com'));
    const fbPosts = await fetchFacebookPosts(withFacebook.map((p) => p.facebookUrl), postsPerPage);

    // Group posts by the page they came from
    const postsByPage = new Map<string, any[]>();
    for (const post of fbPosts) {
        const key = String(post.inputUrl ?? post.facebookUrl ?? '');
        const list = postsByPage.get(key) ?? [];
        list.push(post);
        postsByPage.set(key, list);
    }

    return places.map((p) => ({
        name: p.title,
        address: p.address,
        rating: p.totalScore,
        website: p.website,
        googleMapsUrl: p.url,
        facebookUrl: p.facebookUrl ?? null,
        facebookPosts: postsByPage.get(String(p.facebookUrl)) ?? [],
    }));
}

const server = http.createServer(async (req, res) => {
    if (req.headers['x-apify-container-server-readiness-probe']) {
        res.writeHead(200);
        res.end('ok');
        return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/search') {
        const area = url.searchParams.get('area');
        if (!area) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required query parameter: area' }));
            return;
        }
        try {
            const results = await handleSearch({
                area,
                limit: Number(url.searchParams.get('limit')) || undefined,
                postsPerPage: Number(url.searchParams.get('postsPerPage')) || undefined,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ area, count: results.length, restaurants: results }, null, 2));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
        }
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Use GET /search?area=...' }));
});

server.listen(Actor.config.get('standbyPort'));
