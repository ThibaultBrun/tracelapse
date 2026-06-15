import { reactive } from 'vue'
import { loadGpxText, state } from './store'
import { accessToken } from './supa'

// Same-origin /api → Cloudflare Pages Function → proxied to the VPS service.
// Keeps the Strava callback on the brand domain (tracelapse.pista.bike).
const API = `${location.origin}/api`

export interface StravaActivity {
  id: number
  name: string
  type: string
  distance: number
  moving_time: number
  total_elevation_gain: number
  start_date_local: string
  has_latlng: boolean
}

interface StravaState {
  token: string | null // anonymous session token (browser-only)
  athlete: string
  expires: number
  linked: boolean // Strava linked to the Pista account (stored server-side)
  accountAthlete: string
  notify: boolean
  activities: StravaActivity[]
  loading: boolean
  error: string | null
}

export const strava = reactive<StravaState>({
  token: null,
  athlete: '',
  expires: 0,
  linked: false,
  accountAthlete: '',
  notify: false,
  activities: [],
  loading: false,
  error: null,
})

export const stravaConnected = () => strava.linked || (!!strava.token && strava.expires * 1000 > Date.now())

// --- Anonymous (session-only) connect ---
export function connectStrava() {
  location.href = `${API}/auth`
}

// --- Account link (stores refresh token + enables new-activity emails) ---
export async function connectStravaLink() {
  const jwt = await accessToken()
  if (!jwt) {
    strava.error = 'Sign in first'
    return
  }
  location.href = `${API}/link?token=${encodeURIComponent(jwt)}`
}

/** Read the OAuth result from the URL fragment after returning from Strava. */
export function consumeStravaRedirect() {
  if (!location.hash) return
  const p = new URLSearchParams(location.hash.slice(1))
  const err = p.get('strava_error')
  if (err) {
    strava.error = `Strava: ${err}`
    clearHash()
    return
  }
  if (p.get('linked')) {
    clearHash()
    void refreshAccount()
    return
  }
  const token = p.get('token')
  if (token) {
    strava.token = token
    strava.expires = Number(p.get('expires') || 0)
    strava.athlete = p.get('athlete') || ''
    clearHash()
    void fetchStravaActivities()
  }
}

function clearHash() {
  history.replaceState(null, '', location.pathname + location.search)
}

async function authHeaders(): Promise<Record<string, string>> {
  const jwt = await accessToken()
  return jwt ? { Authorization: `Bearer ${jwt}` } : {}
}

/** Fetch the linked-account status (and activities) for the logged-in user. */
export async function refreshAccount() {
  const jwt = await accessToken()
  if (!jwt) {
    strava.linked = false
    return
  }
  try {
    const me = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${jwt}` } }).then((r) => r.json())
    strava.linked = !!me.linked
    strava.accountAthlete = me.athlete || ''
    strava.notify = !!me.notify
    if (strava.linked) await fetchAccountActivities()
  } catch (e) {
    strava.error = e instanceof Error ? e.message : String(e)
  }
}

export async function fetchAccountActivities() {
  strava.loading = true
  strava.error = null
  try {
    const r = await fetch(`${API}/me/activities`, { headers: await authHeaders() })
    if (!r.ok) throw new Error(`activities ${r.status}`)
    strava.activities = await r.json()
  } catch (e) {
    strava.error = e instanceof Error ? e.message : String(e)
  } finally {
    strava.loading = false
  }
}

export async function fetchStravaActivities() {
  if (!strava.token) return
  strava.loading = true
  strava.error = null
  try {
    const r = await fetch(`${API}/activities`, { headers: { Authorization: `Bearer ${strava.token}` } })
    if (!r.ok) throw new Error(`activities ${r.status}`)
    strava.activities = await r.json()
  } catch (e) {
    strava.error = e instanceof Error ? e.message : String(e)
  } finally {
    strava.loading = false
  }
}

export async function loadStravaActivity(a: StravaActivity) {
  strava.error = null
  state.loading = true
  try {
    const url = strava.linked ? `${API}/me/gpx?id=${a.id}` : `${API}/gpx?id=${a.id}`
    const headers = strava.linked ? await authHeaders() : { Authorization: `Bearer ${strava.token}` }
    const r = await fetch(url, { headers })
    if (!r.ok) throw new Error(`gpx ${r.status}`)
    loadGpxText(await r.text(), a.name)
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e)
  } finally {
    state.loading = false
  }
}

/** Deep link from the notification email: ?a=<activityId> → load that ride. */
export async function loadActivityById(id: string) {
  state.loading = true
  strava.error = null
  try {
    const jwt = await accessToken()
    if (!jwt) {
      strava.error = 'Connecte-toi à ton compte Pista pour ouvrir cette activité.'
      return
    }
    const r = await fetch(`${API}/me/gpx?id=${id}`, { headers: { Authorization: `Bearer ${jwt}` } })
    if (!r.ok) throw new Error(`gpx ${r.status}`)
    loadGpxText(await r.text(), `Strava ${id}`)
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e)
  } finally {
    state.loading = false
  }
}

export async function disconnectStrava() {
  if (strava.linked) {
    await fetch(`${API}/me/disconnect`, { method: 'GET', headers: await authHeaders() }).catch(() => {})
  }
  strava.token = null
  strava.athlete = ''
  strava.linked = false
  strava.accountAthlete = ''
  strava.activities = []
}
