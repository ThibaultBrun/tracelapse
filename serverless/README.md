# Strava / Garmin auto-sync (optional backend)

The Tracelapse app is **100% client-side** — parsing, rendering and video
encoding all run in your browser. The one thing a browser *can't* do safely is
OAuth against Strava/Garmin, because their token exchange requires a
`client_secret` that must never be shipped in a static site.

This folder is a tiny, stateless **Cloudflare Worker** that holds that secret
and lets the front-end pull activities as GPX. It's optional: without it, just
export a GPX from Strava/Garmin Connect and drop it into the app.

## Strava

1. Create an API app at <https://www.strava.com/settings/api>.
2. `npm i -g wrangler && wrangler login`
3. From this folder:
   ```sh
   wrangler secret put STRAVA_CLIENT_ID
   wrangler secret put STRAVA_CLIENT_SECRET
   ```
   Edit `wrangler.toml` → set `REDIRECT_URI` (the deployed `/callback` URL) and
   `APP_ORIGIN` (your site origin, for CORS).
4. `wrangler deploy`
5. Point the app's "Connect Strava" flow at the worker's `/auth` endpoint.

Endpoints: `/auth`, `/callback`, `/activities`, `/gpx?id=<id>`.

## Garmin

Garmin Connect uses OAuth 1.0a + the Activity API (partner approval required).
The same worker pattern applies — swap the `/auth` + `/callback` handlers for
Garmin's OAuth 1.0a signing. PRs welcome.

## Other hosts

The handler is plain `fetch`-style code; it ports directly to a Vercel/Netlify
function or a ~30-line Express server if you'd rather not use Cloudflare.
