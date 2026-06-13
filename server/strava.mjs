#!/usr/bin/env node
/**
 * Tracelapse — Strava OAuth + activity proxy (zero-dependency Node service).
 *
 * Sits behind Caddy at https://tracelapse.tbrun.dev/api/* (Caddy strips /api,
 * so this server sees /auth, /callback, /activities, /gpx). Holds the Strava
 * client secret server-side — the one thing a static front-end can't do.
 *
 * Env (see tracelapse-strava.env):
 *   STRAVA_CLIENT_ID       your Strava API app id
 *   STRAVA_CLIENT_SECRET   your Strava API app secret
 *   REDIRECT_URI           https://tracelapse.tbrun.dev/api/callback
 *   APP_ORIGIN             https://tracelapse.tbrun.dev   (where to send the user back)
 *   PORT                   8030
 */
import { createServer } from 'node:http'

const {
  STRAVA_CLIENT_ID = '',
  STRAVA_CLIENT_SECRET = '',
  REDIRECT_URI = 'https://tracelapse.tbrun.dev/api/callback',
  APP_ORIGIN = 'https://tracelapse.tbrun.dev',
  PORT = '8030',
} = process.env

const STRAVA = 'https://www.strava.com'
const API = 'https://www.strava.com/api/v3'

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Access-Control-Allow-Origin': APP_ORIGIN, ...headers })
  res.end(body)
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' })
}
function bearer(req) {
  const h = req.headers['authorization'] || ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, APP_ORIGIN)
  const path = url.pathname.replace(/\/$/, '') || '/'

  if (req.method === 'OPTIONS') {
    return send(res, 204, '', {
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    })
  }

  try {
    // 1) Kick off OAuth.
    if (path === '/auth' || path === '/api/auth') {
      if (!STRAVA_CLIENT_ID) return send(res, 500, 'Strava not configured (missing STRAVA_CLIENT_ID)')
      const p = new URLSearchParams({
        client_id: STRAVA_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        approval_prompt: 'auto',
        scope: 'read,activity:read_all',
      })
      return send(res, 302, '', { Location: `${STRAVA}/oauth/authorize?${p}` })
    }

    // 2) OAuth callback -> exchange code, bounce back to the app with the token.
    if (path === '/callback' || path === '/api/callback') {
      const err = url.searchParams.get('error')
      if (err) return send(res, 302, '', { Location: `${APP_ORIGIN}/#strava_error=${encodeURIComponent(err)}` })
      const code = url.searchParams.get('code')
      if (!code) return send(res, 400, 'missing code')
      const r = await fetch(`${STRAVA}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: STRAVA_CLIENT_ID,
          client_secret: STRAVA_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
        }),
      })
      const data = await r.json()
      if (!r.ok || !data.access_token) {
        return send(res, 302, '', { Location: `${APP_ORIGIN}/#strava_error=exchange_failed` })
      }
      const name = data.athlete ? `${data.athlete.firstname || ''} ${data.athlete.lastname || ''}`.trim() : ''
      const frag = new URLSearchParams({ token: data.access_token, expires: String(data.expires_at || 0), athlete: name })
      return send(res, 302, '', { Location: `${APP_ORIGIN}/#${frag}` })
    }

    // 3) List recent activities (token forwarded from the browser).
    if (path === '/activities' || path === '/api/activities') {
      const token = bearer(req)
      if (!token) return json(res, 401, { error: 'no token' })
      const r = await fetch(`${API}/athlete/activities?per_page=30`, { headers: { Authorization: `Bearer ${token}` } })
      const list = await r.json()
      if (!r.ok) return json(res, r.status, list)
      const slim = (Array.isArray(list) ? list : []).map((a) => ({
        id: a.id,
        name: a.name,
        type: a.sport_type || a.type,
        distance: a.distance,
        moving_time: a.moving_time,
        total_elevation_gain: a.total_elevation_gain,
        start_date_local: a.start_date_local,
        has_latlng: !!(a.map && a.map.summary_polyline),
      }))
      return json(res, 200, slim)
    }

    // 4) Build a GPX for one activity from its streams.
    if (path === '/gpx' || path === '/api/gpx') {
      const token = bearer(req)
      const id = url.searchParams.get('id')
      if (!token || !id) return json(res, 400, { error: 'token + id required' })
      const keys = 'latlng,altitude,time,heartrate,cadence,temp,watts'
      const r = await fetch(`${API}/activities/${id}/streams?keys=${keys}&key_by_type=true`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const s = await r.json()
      if (!r.ok) return json(res, r.status, s)
      // Strava streams have no absolute start time here; use the activity's start.
      const meta = await fetch(`${API}/activities/${id}`, { headers: { Authorization: `Bearer ${token}` } })
        .then((m) => m.json())
        .catch(() => ({}))
      const startMs = meta.start_date ? Date.parse(meta.start_date) : Date.now()
      return send(res, 200, streamsToGpx(s, meta.name || `Strava ${id}`, meta.sport_type || meta.type, startMs), {
        'Content-Type': 'application/gpx+xml',
      })
    }

    if (path === '/' || path === '/health') return send(res, 200, 'tracelapse-strava ok')
    return send(res, 404, 'not found')
  } catch (e) {
    return json(res, 500, { error: String(e) })
  }
})

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]))
}

function streamsToGpx(s, name, sport, startMs) {
  const latlng = s.latlng?.data || []
  const alt = s.altitude?.data || []
  const time = s.time?.data || []
  const hr = s.heartrate?.data || []
  const cad = s.cadence?.data || []
  const temp = s.temp?.data || []
  const watts = s.watts?.data || []
  const pts = latlng
    .map((ll, i) => {
      const t = new Date(startMs + (time[i] ?? i) * 1000).toISOString()
      const ext =
        hr[i] != null || cad[i] != null || temp[i] != null || watts[i] != null
          ? `<extensions>${watts[i] != null ? `<power>${watts[i]}</power>` : ''}<gpxtpx:TrackPointExtension>${
              hr[i] != null ? `<gpxtpx:hr>${hr[i]}</gpxtpx:hr>` : ''
            }${cad[i] != null ? `<gpxtpx:cad>${cad[i]}</gpxtpx:cad>` : ''}${
              temp[i] != null ? `<gpxtpx:atemp>${temp[i]}</gpxtpx:atemp>` : ''
            }</gpxtpx:TrackPointExtension></extensions>`
          : ''
      return `<trkpt lat="${ll[0]}" lon="${ll[1]}"><ele>${alt[i] ?? 0}</ele><time>${t}</time>${ext}</trkpt>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="tracelapse" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
<trk><name>${xmlEscape(name)}</name><type>${xmlEscape(sport || '')}</type><trkseg>${pts}</trkseg></trk></gpx>`
}

server.listen(Number(PORT), '127.0.0.1', () => {
  console.log(`tracelapse-strava listening on 127.0.0.1:${PORT} (configured=${!!STRAVA_CLIENT_ID})`)
})
