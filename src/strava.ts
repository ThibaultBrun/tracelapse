import { reactive } from 'vue'
import { loadGpxText, state } from './store'

/** Backend lives behind the same origin at /api (Caddy → Node service). */
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
  token: string | null
  athlete: string
  expires: number
  activities: StravaActivity[]
  loading: boolean
  error: string | null
}

export const strava = reactive<StravaState>({
  token: null,
  athlete: '',
  expires: 0,
  activities: [],
  loading: false,
  error: null,
})

export const stravaConnected = () => !!strava.token && strava.expires * 1000 > Date.now()

/** Begin the OAuth flow (full-page redirect to the backend → Strava). */
export function connectStrava() {
  location.href = `${API}/auth`
}

/** On app boot, pick up the token the backend put in the URL fragment. */
export function consumeStravaRedirect() {
  if (!location.hash) return
  const p = new URLSearchParams(location.hash.slice(1))
  const err = p.get('strava_error')
  if (err) {
    strava.error = `Strava: ${err}`
    history.replaceState(null, '', location.pathname + location.search)
    return
  }
  const token = p.get('token')
  if (!token) return
  strava.token = token
  strava.expires = Number(p.get('expires') || 0)
  strava.athlete = p.get('athlete') || ''
  history.replaceState(null, '', location.pathname + location.search)
  void fetchStravaActivities()
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

/** Pull one activity's GPX from the backend and load it into the editor. */
export async function loadStravaActivity(a: StravaActivity) {
  strava.error = null
  state.loading = true
  try {
    const r = await fetch(`${API}/gpx?id=${a.id}`, { headers: { Authorization: `Bearer ${strava.token}` } })
    if (!r.ok) throw new Error(`gpx ${r.status}`)
    loadGpxText(await r.text(), a.name)
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e)
  } finally {
    state.loading = false
  }
}

export function disconnectStrava() {
  strava.token = null
  strava.athlete = ''
  strava.activities = []
}
