#!/usr/bin/env node
/**
 * Tracelapse — Strava OAuth + activity proxy + account linking + new-activity
 * notifications. Zero-dependency Node service (behind Caddy at /api/*).
 *
 * Two flows:
 *  - Anonymous: /auth → /callback → token in URL fragment → client lists/loads (no storage).
 *  - Account-linked: /link?token=<supabase_jwt> → /callback stores the Strava
 *    refresh token against the Pista user (table public.tracelapse_strava), and a
 *    Strava webhook then drops a "new activity" email into Pista's mail_outbox.
 *
 * Env (/etc/tracelapse-strava.env):
 *   STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_VERIFY_TOKEN
 *   REDIRECT_URI   = https://tracelapse.tbrun.dev/api/callback
 *   APP_ORIGIN     = https://tracelapse.pista.bike
 *   SUPABASE_URL   = https://api.pista.bike
 *   SUPABASE_ANON, SUPABASE_SERVICE
 *   PORT           = 8030
 */
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'

const {
  STRAVA_CLIENT_ID = '',
  STRAVA_CLIENT_SECRET = '',
  STRAVA_VERIFY_TOKEN = 'tracelapse',
  REDIRECT_URI = 'https://tracelapse.tbrun.dev/api/callback',
  APP_ORIGIN = 'https://tracelapse.pista.bike',
  SUPABASE_URL = 'https://api.pista.bike',
  SUPABASE_ANON = '',
  SUPABASE_SERVICE = '',
  PORT = '8030',
} = process.env

const STRAVA = 'https://www.strava.com'
const API = 'https://www.strava.com/api/v3'
const TABLE = `${SUPABASE_URL}/rest/v1/tracelapse_strava`
const svcHeaders = { apikey: SUPABASE_SERVICE, Authorization: `Bearer ${SUPABASE_SERVICE}`, 'Content-Type': 'application/json' }

// ---------- helpers ----------
function cors(res, extra = {}) {
  res.writeHead(extra._status || 200, {
    'Access-Control-Allow-Origin': APP_ORIGIN,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== '_status')),
  })
}
const sendJson = (res, status, obj) => {
  cors(res, { _status: status, 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}
const sendText = (res, status, body, headers = {}) => {
  cors(res, { _status: status, ...headers })
  res.end(body)
}
const redirect = (res, location) => {
  cors(res, { _status: 302, Location: location })
  res.end()
}
const bearer = (req) => {
  const h = req.headers['authorization'] || ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}
const unsubSig = (athleteId) => createHmac('sha256', STRAVA_CLIENT_SECRET).update(String(athleteId)).digest('hex').slice(0, 24)

const EVENTS = new Set(['visit', 'connect_anon', 'connect_link', 'activity_loaded', 'video_exported', 'shared'])
/** Fire-and-forget usage log into public.tracelapse_events (server-side count). */
function logEvent(event, athleteId = null) {
  if (!EVENTS.has(event)) return
  void fetch(`${SUPABASE_URL}/rest/v1/tracelapse_events`, {
    method: 'POST',
    headers: { ...svcHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ event, athlete_id: athleteId }),
  }).catch(() => {})
}
async function countEvent(filter) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${filter}`, { headers: { ...svcHeaders, Prefer: 'count=exact' }, method: 'HEAD' })
  const cr = r.headers.get('content-range') || '*/0'
  return Number(cr.split('/')[1] || 0)
}

/** Validate a Supabase JWT and return { id, email } or null. */
async function supaUser(jwt) {
  if (!jwt) return null
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${jwt}` },
  })
  if (!r.ok) return null
  const u = await r.json()
  return u && u.id ? { id: u.id, email: u.email } : null
}

async function exchangeCode(code) {
  const r = await fetch(`${STRAVA}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET, code, grant_type: 'authorization_code' }),
  })
  return r.json()
}

async function refreshToken(refresh_token) {
  const r = await fetch(`${STRAVA}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET, refresh_token, grant_type: 'refresh_token' }),
  })
  return r.json()
}

async function getRow(filter) {
  const r = await fetch(`${TABLE}?${filter}&limit=1`, { headers: svcHeaders })
  const rows = r.ok ? await r.json() : []
  return rows[0] || null
}

/** Return a valid Strava access token for a stored row, refreshing if expired. */
async function validAccess(row) {
  const now = Math.floor(Date.now() / 1000)
  const exp = row.expires_at ? Math.floor(new Date(row.expires_at).getTime() / 1000) : 0
  if (row.access_token && exp - 60 > now) return row.access_token
  const t = await refreshToken(row.refresh_token)
  if (!t.access_token) throw new Error('refresh failed')
  await fetch(`${TABLE}?user_id=eq.${row.user_id}`, {
    method: 'PATCH',
    headers: svcHeaders,
    body: JSON.stringify({
      access_token: t.access_token,
      refresh_token: t.refresh_token || row.refresh_token,
      expires_at: new Date((t.expires_at || 0) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }),
  })
  return t.access_token
}

// ---------- server ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = (url.pathname.replace(/^\/api/, '') || '/').replace(/\/$/, '') || '/'
  if (req.method === 'OPTIONS') return sendText(res, 204, '')

  try {
    // --- OAuth start (anon or account-link) ---
    if (path === '/auth' || path === '/link') {
      if (!STRAVA_CLIENT_ID) return sendText(res, 500, 'not configured')
      const state = path === '/link' ? `link:${url.searchParams.get('token') || ''}` : 'anon'
      const p = new URLSearchParams({
        client_id: STRAVA_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        approval_prompt: 'auto',
        scope: 'read,activity:read_all',
        state,
      })
      return redirect(res, `${STRAVA}/oauth/authorize?${p}`)
    }

    // --- OAuth callback ---
    if (path === '/callback') {
      const err = url.searchParams.get('error')
      if (err) return redirect(res, `${APP_ORIGIN}/#strava_error=${encodeURIComponent(err)}`)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state') || 'anon'
      if (!code) return sendText(res, 400, 'missing code')
      const data = await exchangeCode(code)
      if (!data.access_token) return redirect(res, `${APP_ORIGIN}/#strava_error=exchange_failed`)
      const athlete = data.athlete || {}
      const name = `${athlete.firstname || ''} ${athlete.lastname || ''}`.trim()
      logEvent(state.startsWith('link:') ? 'connect_link' : 'connect_anon', athlete.id ?? null)

      if (state.startsWith('link:')) {
        const user = await supaUser(state.slice(5))
        if (!user) return redirect(res, `${APP_ORIGIN}/#strava_error=not_logged_in`)
        await fetch(`${TABLE}?on_conflict=user_id`, {
          method: 'POST',
          headers: { ...svcHeaders, Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({
            user_id: user.id,
            email: user.email,
            athlete_id: athlete.id,
            athlete_name: name,
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: new Date((data.expires_at || 0) * 1000).toISOString(),
            scope: 'read,activity:read_all',
            notify: true,
            updated_at: new Date().toISOString(),
          }),
        })
        return redirect(res, `${APP_ORIGIN}/#linked=1&athlete=${encodeURIComponent(name)}`)
      }

      const frag = new URLSearchParams({ token: data.access_token, expires: String(data.expires_at || 0), athlete: name })
      return redirect(res, `${APP_ORIGIN}/#${frag}`)
    }

    // --- Anonymous proxy (client holds the Strava token) ---
    if (path === '/activities') {
      const token = bearer(req)
      if (!token) return sendJson(res, 401, { error: 'no token' })
      return sendJson(res, 200, await listActivities(token))
    }
    if (path === '/gpx') {
      const token = bearer(req)
      const id = url.searchParams.get('id')
      if (!token || !id) return sendJson(res, 400, { error: 'token + id required' })
      logEvent('activity_loaded')
      return sendText(res, 200, await activityGpx(token, id), { 'Content-Type': 'application/gpx+xml' })
    }

    // Usage event from the client (whitelisted names only).
    if (path === '/ev') {
      logEvent(url.searchParams.get('name') || '')
      return sendText(res, 204, '')
    }

    // Aggregate usage counts (no PII).
    if (path === '/stats') {
      const ev = (n) => countEvent(`tracelapse_events?event=eq.${n}`)
      const [visit, ca, cl, loaded, exported, shared, linked] = await Promise.all([
        ev('visit'), ev('connect_anon'), ev('connect_link'), ev('activity_loaded'),
        ev('video_exported'), ev('shared'), countEvent('tracelapse_strava?select=user_id'),
      ])
      return sendJson(res, 200, {
        visits: visit,
        strava_connects: ca + cl,
        linked_accounts: linked,
        activities_loaded: loaded,
        videos_exported: exported,
        shares: shared,
      })
    }

    // --- Account flows (client sends the Supabase JWT) ---
    if (path === '/me') {
      const user = await supaUser(bearer(req))
      if (!user) return sendJson(res, 401, { error: 'not logged in' })
      const row = await getRow(`user_id=eq.${user.id}`)
      return sendJson(res, 200, { linked: !!row, athlete: row?.athlete_name || null, notify: row?.notify ?? false })
    }
    if (path === '/me/activities') {
      const user = await supaUser(bearer(req))
      if (!user) return sendJson(res, 401, { error: 'not logged in' })
      const row = await getRow(`user_id=eq.${user.id}`)
      if (!row) return sendJson(res, 404, { error: 'not linked' })
      return sendJson(res, 200, await listActivities(await validAccess(row)))
    }
    if (path === '/me/gpx') {
      const user = await supaUser(bearer(req))
      const id = url.searchParams.get('id')
      if (!user) return sendJson(res, 401, { error: 'not logged in' })
      const row = await getRow(`user_id=eq.${user.id}`)
      if (!row || !id) return sendJson(res, 400, { error: 'not linked / id' })
      logEvent('activity_loaded', row.athlete_id ?? null)
      return sendText(res, 200, await activityGpx(await validAccess(row), id), { 'Content-Type': 'application/gpx+xml' })
    }
    if (path === '/me/disconnect') {
      const user = await supaUser(bearer(req))
      if (!user) return sendJson(res, 401, { error: 'not logged in' })
      await fetch(`${TABLE}?user_id=eq.${user.id}`, { method: 'DELETE', headers: svcHeaders })
      return sendJson(res, 200, { ok: true })
    }

    // --- Strava webhook ---
    if (path === '/webhook') {
      if (req.method === 'GET') {
        const challenge = url.searchParams.get('hub.challenge')
        const verify = url.searchParams.get('hub.verify_token')
        if (verify === STRAVA_VERIFY_TOKEN) return sendJson(res, 200, { 'hub.challenge': challenge })
        return sendJson(res, 403, { error: 'bad verify token' })
      }
      // POST event — read body
      const body = await readBody(req)
      // Respond 200 immediately; process async.
      sendJson(res, 200, { ok: true })
      void handleEvent(body).catch((e) => console.error('[tracelapse] webhook', e))
      return
    }

    // --- Unsubscribe link from the email ---
    if (path === '/unsubscribe') {
      const a = url.searchParams.get('a')
      const k = url.searchParams.get('k')
      if (a && k === unsubSig(a)) {
        await fetch(`${TABLE}?athlete_id=eq.${a}`, { method: 'PATCH', headers: svcHeaders, body: JSON.stringify({ notify: false }) })
        return sendText(res, 200, 'Désinscrit des alertes Tracelapse. Tu peux fermer cette page.')
      }
      return sendText(res, 400, 'lien invalide')
    }

    if (path === '/' || path === '/health') return sendText(res, 200, `tracelapse-strava ok (configured=${!!STRAVA_CLIENT_ID})`)
    return sendText(res, 404, 'not found')
  } catch (e) {
    return sendJson(res, 500, { error: String(e) })
  }
})

function readBody(req) {
  return new Promise((resolve) => {
    let d = ''
    req.on('data', (c) => (d += c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(d || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

async function handleEvent(ev) {
  if (ev.object_type !== 'activity' || ev.aspect_type !== 'create') return
  const row = await getRow(`athlete_id=eq.${ev.owner_id}`)
  if (!row || !row.notify || !row.email) return
  const link = `${APP_ORIGIN}/?a=${ev.object_id}`
  const unsub = `${REDIRECT_URI.replace('/api/callback', '/api/unsubscribe')}?a=${row.athlete_id}&k=${unsubSig(row.athlete_id)}`
  const subject = '🎬 Nouvelle sortie — génère ta vidéo Tracelapse'
  const body =
    `Salut${row.athlete_name ? ' ' + row.athlete_name.split(' ')[0] : ''} !\n\n` +
    `Ta nouvelle activité Strava est prête à devenir une vidéo cinématique 3D.\n\n` +
    `👉 Génère-la ici : ${link}\n\n` +
    `Bonne route 🚵\nTracelapse\n\n` +
    `—\nNe plus recevoir ces alertes : ${unsub}`
  await fetch(`${SUPABASE_URL}/rest/v1/mail_outbox`, {
    method: 'POST',
    headers: svcHeaders,
    body: JSON.stringify({ to_email: row.email, subject, body }),
  })
}

async function listActivities(token) {
  const r = await fetch(`${API}/athlete/activities?per_page=30`, { headers: { Authorization: `Bearer ${token}` } })
  const list = await r.json()
  if (!Array.isArray(list)) return []
  return list.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.sport_type || a.type,
    distance: a.distance,
    moving_time: a.moving_time,
    total_elevation_gain: a.total_elevation_gain,
    start_date_local: a.start_date_local,
    has_latlng: !!(a.map && a.map.summary_polyline),
  }))
}

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]))
}

async function activityGpx(token, id) {
  const keys = 'latlng,altitude,time,heartrate,cadence,temp,watts'
  const s = await fetch(`${API}/activities/${id}/streams?keys=${keys}&key_by_type=true`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json())
  const meta = await fetch(`${API}/activities/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => ({}))
  const startMs = meta.start_date ? Date.parse(meta.start_date) : Date.now()
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
          ? `<extensions>${watts[i] != null ? `<power>${watts[i]}</power>` : ''}<gpxtpx:TrackPointExtension>${hr[i] != null ? `<gpxtpx:hr>${hr[i]}</gpxtpx:hr>` : ''}${cad[i] != null ? `<gpxtpx:cad>${cad[i]}</gpxtpx:cad>` : ''}${temp[i] != null ? `<gpxtpx:atemp>${temp[i]}</gpxtpx:atemp>` : ''}</gpxtpx:TrackPointExtension></extensions>`
          : ''
      return `<trkpt lat="${ll[0]}" lon="${ll[1]}"><ele>${alt[i] ?? 0}</ele><time>${t}</time>${ext}</trkpt>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="tracelapse" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
<trk><name>${xmlEscape(meta.name || `Strava ${id}`)}</name><type>${xmlEscape(meta.sport_type || meta.type || '')}</type><trkseg>${pts}</trkseg></trk></gpx>`
}

server.listen(Number(PORT), '127.0.0.1', () => console.log(`tracelapse-strava on :${PORT} (configured=${!!STRAVA_CLIENT_ID})`))
