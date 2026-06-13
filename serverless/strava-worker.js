/**
 * Tracelapse — minimal Strava OAuth + activity proxy (Cloudflare Worker).
 *
 * Why this exists: Strava's OAuth requires a `client_secret` for the token
 * exchange, which must never ship in a static front-end. This tiny stateless
 * worker holds the secret and exposes three endpoints the front-end calls:
 *
 *   GET  /auth            -> 302 redirect to Strava's consent screen
 *   GET  /callback?code=  -> exchanges the code, returns { access_token, athlete }
 *   GET  /activities      -> proxied list (Authorization: Bearer <token>)
 *   GET  /gpx?id=<id>     -> builds a GPX stream from an activity's latlng/altitude
 *
 * Deploy:
 *   1. npm i -g wrangler && wrangler login
 *   2. Set secrets:
 *        wrangler secret put STRAVA_CLIENT_ID
 *        wrangler secret put STRAVA_CLIENT_SECRET
 *      and vars REDIRECT_URI (this worker's /callback) + APP_ORIGIN (your site).
 *   3. wrangler deploy
 *
 * The same logic ports 1:1 to a Vercel/Netlify function or a 30-line Express app.
 */

const STRAVA = 'https://www.strava.com'
const API = 'https://www.strava.com/api/v3'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const cors = {
      'Access-Control-Allow-Origin': env.APP_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    }
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors })

    try {
      if (url.pathname === '/auth') {
        const p = new URLSearchParams({
          client_id: env.STRAVA_CLIENT_ID,
          redirect_uri: env.REDIRECT_URI,
          response_type: 'code',
          approval_prompt: 'auto',
          scope: 'read,activity:read_all',
        })
        return Response.redirect(`${STRAVA}/oauth/authorize?${p}`, 302)
      }

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code')
        if (!code) return json({ error: 'missing code' }, 400, cors)
        const r = await fetch(`${STRAVA}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: env.STRAVA_CLIENT_ID,
            client_secret: env.STRAVA_CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
          }),
        })
        const data = await r.json()
        return json(
          { access_token: data.access_token, expires_at: data.expires_at, athlete: data.athlete },
          r.ok ? 200 : 400,
          cors,
        )
      }

      if (url.pathname === '/activities') {
        const auth = request.headers.get('Authorization')
        if (!auth) return json({ error: 'no token' }, 401, cors)
        const r = await fetch(`${API}/athlete/activities?per_page=30`, {
          headers: { Authorization: auth },
        })
        return json(await r.json(), r.status, cors)
      }

      if (url.pathname === '/gpx') {
        const auth = request.headers.get('Authorization')
        const id = url.searchParams.get('id')
        if (!auth || !id) return json({ error: 'token + id required' }, 400, cors)
        const r = await fetch(
          `${API}/activities/${id}/streams?keys=latlng,altitude,time,heartrate,cadence&key_by_type=true`,
          { headers: { Authorization: auth } },
        )
        const s = await r.json()
        return new Response(streamsToGpx(s, id), {
          headers: { ...cors, 'Content-Type': 'application/gpx+xml' },
        })
      }

      return new Response('Tracelapse Strava worker', { headers: cors })
    } catch (e) {
      return json({ error: String(e) }, 500, cors)
    }
  },
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

function streamsToGpx(s, id) {
  const latlng = s.latlng?.data || []
  const alt = s.altitude?.data || []
  const time = s.time?.data || []
  const hr = s.heartrate?.data || []
  const cad = s.cadence?.data || []
  const base = Date.now()
  const pts = latlng
    .map((ll, i) => {
      const t = new Date(base + (time[i] ?? i) * 1000).toISOString()
      const ext =
        hr[i] != null || cad[i] != null
          ? `<extensions><gpxtpx:TrackPointExtension>${
              hr[i] != null ? `<gpxtpx:hr>${hr[i]}</gpxtpx:hr>` : ''
            }${cad[i] != null ? `<gpxtpx:cad>${cad[i]}</gpxtpx:cad>` : ''}</gpxtpx:TrackPointExtension></extensions>`
          : ''
      return `<trkpt lat="${ll[0]}" lon="${ll[1]}"><ele>${alt[i] ?? 0}</ele><time>${t}</time>${ext}</trkpt>`
    })
    .join('')
  return `<?xml version="1.0"?><gpx version="1.1" creator="tracelapse" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><trk><name>Strava ${id}</name><trkseg>${pts}</trkseg></trk></gpx>`
}
