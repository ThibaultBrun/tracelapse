/**
 * Tracelapse — Strava OAuth + activity proxy as a Cloudflare Pages Function.
 * Handles /api/auth, /api/callback, /api/activities, /api/gpx.
 *
 * Env (Pages project → Settings → Environment variables / secrets):
 *   STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET (secret),
 *   REDIRECT_URI   = https://tracelapse.pista.bike/api/callback
 *   APP_ORIGIN     = https://tracelapse.pista.bike
 */
const STRAVA = 'https://www.strava.com'
const API = 'https://www.strava.com/api/v3'

export async function onRequest(context) {
  const { request, env } = context
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/$/, '')
  const APP_ORIGIN = env.APP_ORIGIN || url.origin
  const REDIRECT_URI = env.REDIRECT_URI || `${url.origin}/api/callback`
  const cors = { 'Access-Control-Allow-Origin': APP_ORIGIN }

  const send = (status, body, headers = {}) =>
    new Response(body, { status, headers: { ...cors, ...headers } })
  const json = (status, obj) => send(status, JSON.stringify(obj), { 'Content-Type': 'application/json' })
  const bearer = () => {
    const h = request.headers.get('authorization') || ''
    return h.startsWith('Bearer ') ? h.slice(7) : null
  }

  if (request.method === 'OPTIONS') {
    return send(204, '', {
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    })
  }

  try {
    if (path === '/api/auth') {
      if (!env.STRAVA_CLIENT_ID) return send(500, 'Strava not configured')
      const p = new URLSearchParams({
        client_id: env.STRAVA_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        approval_prompt: 'auto',
        scope: 'read,activity:read_all',
      })
      return Response.redirect(`${STRAVA}/oauth/authorize?${p}`, 302)
    }

    if (path === '/api/callback') {
      const err = url.searchParams.get('error')
      if (err) return Response.redirect(`${APP_ORIGIN}/#strava_error=${encodeURIComponent(err)}`, 302)
      const code = url.searchParams.get('code')
      if (!code) return send(400, 'missing code')
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
      if (!r.ok || !data.access_token) return Response.redirect(`${APP_ORIGIN}/#strava_error=exchange_failed`, 302)
      const name = data.athlete ? `${data.athlete.firstname || ''} ${data.athlete.lastname || ''}`.trim() : ''
      const frag = new URLSearchParams({ token: data.access_token, expires: String(data.expires_at || 0), athlete: name })
      return Response.redirect(`${APP_ORIGIN}/#${frag}`, 302)
    }

    if (path === '/api/activities') {
      const token = bearer()
      if (!token) return json(401, { error: 'no token' })
      const r = await fetch(`${API}/athlete/activities?per_page=30`, { headers: { Authorization: `Bearer ${token}` } })
      const list = await r.json()
      if (!r.ok) return json(r.status, list)
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
      return json(200, slim)
    }

    if (path === '/api/gpx') {
      const token = bearer()
      const id = url.searchParams.get('id')
      if (!token || !id) return json(400, { error: 'token + id required' })
      const keys = 'latlng,altitude,time,heartrate,cadence,temp,watts'
      const r = await fetch(`${API}/activities/${id}/streams?keys=${keys}&key_by_type=true`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const s = await r.json()
      if (!r.ok) return json(r.status, s)
      const meta = await fetch(`${API}/activities/${id}`, { headers: { Authorization: `Bearer ${token}` } })
        .then((m) => m.json())
        .catch(() => ({}))
      const startMs = meta.start_date ? Date.parse(meta.start_date) : Date.now()
      return send(200, streamsToGpx(s, meta.name || `Strava ${id}`, meta.sport_type || meta.type, startMs), {
        'Content-Type': 'application/gpx+xml',
      })
    }

    return json(404, { error: 'not found' })
  } catch (e) {
    return json(500, { error: String(e) })
  }
}

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
