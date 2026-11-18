# Restaurant specials API

Apify Actor that finds restaurants and bars in an area, reads their recent Facebook posts and uses Gemini to pull out **specials and events**: weekly specials, once-off specials and events such as rugby on the big screen, karaoke or quiz nights. It's built to feed Dop & Dine with Cape Town Northern Suburbs venues.

## How it works

1. **Find venues.** It runs a Google Maps search (`compass/crawler-google-places`) for each area and search term and gets each venue's Facebook page, either from its Maps listing or from its website. You can add your own Facebook pages under *Extra Facebook pages*. The venue list is cached and reused for 30 days by default, so weekly runs only pay for Facebook posts.
2. **Read posts.** It reads the recent posts of every venue page in one `apify/facebook-posts-scraper` run. Only posts from the last *N* days are fetched.
3. **Extract specials.** It sends each venue's posts to Gemini, together with the first photo of each post because many specials are only on the poster. Gemini returns structured items. Without a Gemini key, or if the daily quota runs out, it falls back to a keyword filter in English and Afrikaans.

## Output

**Dataset**: one row per special or event:

| Field | Example |
|---|---|
| `kind` | `weekly_special`, `once_off_special` or `event` |
| `title`, `description` | "Taco Tuesday", "3 beef tacos, 17:00–21:00" |
| `price` | `R89` |
| `days` | `["Tuesday"]` |
| `date`, `validUntil` | `2026-11-28` (once-off specials and events) |
| `startTime`, `endTime` | `17:00` |
| `confidence` | 0–1 |
| `extractedBy` | `gemini` or `keywords` |
| venue fields | `venueName`, `area`, `address`, `lat`, `lng`, `phone`, `website`, `googleMapsUrl`, `facebookUrl` |
| post fields | `postUrl`, `postDate`, `postText`, `imageUrl` |
| `id` | stable hash of post + special, for de-duplicating between runs |

**Key-value store**:
- `VENUES`: every venue found, including those without Facebook, for importing into the app.
- `SUMMARY`: counts for the run.

To read the latest results from the app or a script:

```
https://api.apify.com/v2/acts/dulcet_hawser~restaurant-specials-api/runs/last/dataset/items?status=SUCCEEDED&clean=true&token=<APIFY_TOKEN>
```

## Cost (Apify free tier prices)

- Google Maps: about $0.006 per venue (place plus website contacts). Only charged when venues are re-discovered, which is every 30 days by default.
- Facebook posts: about $0.007 per recent post ($0.005 per post plus $0.002 for the date filter). 100 venues × 5 posts comes to roughly $3.50 at most.
- Gemini: free tier, with one request per venue that has recent posts. It uses `gemini-3.5-flash-lite` first. Each model has its own small free daily quota (`gemini-3.8-flash` allows only 20 requests a day), so when one runs out the Actor moves on to the *Fallback Gemini models*, and only after that to keywords. You can see your limits at https://aistudio.google.com/rate-limit.
- Hard caps: *Max Google Maps cost* and *Max Facebook posts cost*.

## Setup

1. In Apify Console, open the Actor, go to **Source** and choose **Git repository** with the URL `https://github.com/hj367/restaurant-specials-api`, then **Build**.
2. In **Settings**, turn off **Server** (Standby), because this Actor runs as a normal batch job. Set the run **Timeout** to 3600 s.
3. Add your Gemini API key from https://aistudio.google.com/apikey. Under **Source → Environment variables**, add `GEMINI_API_KEY`, tick **Secret**, save and rebuild. This works for API and scheduled runs too. Alternatively, paste it into the *Gemini API key* input field.
4. Optional: add a weekly **Schedule**.

## Development

```
npm install
npm test        # helper tests
npm run build   # type-check + compile to dist/
```
