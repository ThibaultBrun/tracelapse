import type { Activity } from './core/types'
import { haversine } from './core/metrics'

// Public Pista (self-host Supabase) — anon key, read-only, CORS '*'.
const PISTA_URL = 'https://api.pista.bike'
const PISTA_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgwMzUwMDAyLCJleHAiOjIwOTU3MTAwMDJ9.QgFqLl2IkRA_gjjX6JF8qIYdUBDT-2XIdnPYOrs5lzc'

const headers = { apikey: PISTA_ANON, Authorization: `Bearer ${PISTA_ANON}`, 'Content-Type': 'application/json' }

export interface TrailInfo {
  name: string
  difficulty: string | null
}

export interface PistaTrails {
  geojson: GeoJSON.FeatureCollection
  /** trailId -> info */
  info: Record<string, TrailInfo>
  /** Per activity-point index: trailId the rider is on, or null. */
  matched: (string | null)[]
  spotName: string
}

interface Spot {
  id: string
  name: string
  center_geom: { coordinates: [number, number] } | null
}

/** Load the trails of the Pista spot nearest the activity, and match the trace. */
export async function loadPistaTrails(act: Activity): Promise<PistaTrails | null> {
  const [w, s, e, n] = act.bbox
  const cLng = (w + e) / 2
  const cLat = (s + n) / 2

  const spots: Spot[] = await fetch(`${PISTA_URL}/rest/v1/spots?select=id,name,center_geom`, { headers }).then((r) =>
    r.ok ? r.json() : [],
  )
  // Nearest spot whose centre is within ~40 km of the activity centre.
  let best: Spot | null = null
  let bestD = Infinity
  for (const sp of spots) {
    const c = sp.center_geom?.coordinates
    if (!c) continue
    const d = haversine(cLat, cLng, c[1], c[0])
    if (d < bestD) {
      bestD = d
      best = sp
    }
  }
  if (!best || bestD > 40000) return null

  const geojson: GeoJSON.FeatureCollection = await fetch(`${PISTA_URL}/rest/v1/rpc/get_spot_trails_geojson`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_spot_id: best.id }),
  }).then((r) => (r.ok ? r.json() : { type: 'FeatureCollection', features: [] }))

  const info: Record<string, TrailInfo> = {}
  for (const f of geojson.features) {
    const id = String(f.id ?? f.properties?.id ?? '')
    if (!id) continue
    info[id] = { name: f.properties?.name ?? 'Trail', difficulty: f.properties?.difficulty ?? null }
    f.id = id // ensure feature-state / filter by id works
    if (f.properties) f.properties.id = id
  }

  const matched = matchTrace(act, geojson)
  return { geojson, info, matched, spotName: best.name }
}

/** Snap each activity point to the nearest trail vertex within a threshold (grid-indexed). */
function matchTrace(act: Activity, fc: GeoJSON.FeatureCollection): (string | null)[] {
  const THRESH = 25 // metres
  const cell = 0.0003 // ~33 m, grid cell in degrees
  const grid = new Map<string, { lng: number; lat: number; id: string }[]>()
  const key = (lng: number, lat: number) => `${Math.round(lng / cell)}_${Math.round(lat / cell)}`

  const addVertex = (lng: number, lat: number, id: string) => {
    const k = key(lng, lat)
    let arr = grid.get(k)
    if (!arr) grid.set(k, (arr = []))
    arr.push({ lng, lat, id })
  }
  const walk = (coords: any, id: string) => {
    if (typeof coords[0] === 'number') addVertex(coords[0], coords[1], id)
    else for (const c of coords) walk(c, id)
  }
  for (const f of fc.features) {
    const id = String(f.id ?? '')
    if (id && f.geometry && 'coordinates' in f.geometry) walk((f.geometry as any).coordinates, id)
  }

  const out: (string | null)[] = new Array(act.points.length).fill(null)
  for (let i = 0; i < act.points.length; i++) {
    const p = act.points[i]
    const kx = Math.round(p.lon / cell)
    const ky = Math.round(p.lat / cell)
    let bestId: string | null = null
    let bestD = THRESH
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = grid.get(`${kx + dx}_${ky + dy}`)
        if (!arr) continue
        for (const v of arr) {
          const d = haversine(p.lat, p.lon, v.lat, v.lng)
          if (d < bestD) {
            bestD = d
            bestId = v.id
          }
        }
      }
    }
    out[i] = bestId
  }
  return smoothMatches(out)
}

/** Bridge short gaps and drop tiny runs so the highlight doesn't flicker. */
function smoothMatches(m: (string | null)[]): (string | null)[] {
  const out = m.slice()
  const GAP = 6
  // Fill short null gaps between the same trail.
  for (let i = 0; i < out.length; i++) {
    if (out[i] != null) continue
    let j = i
    while (j < out.length && out[j] == null) j++
    const before = i > 0 ? out[i - 1] : null
    const after = j < out.length ? out[j] : null
    if (before && before === after && j - i <= GAP) {
      for (let k = i; k < j; k++) out[k] = before
    }
    i = j - 1
  }
  // Drop runs shorter than MIN.
  const MIN = 4
  for (let i = 0; i < out.length; ) {
    if (out[i] == null) {
      i++
      continue
    }
    let j = i
    while (j < out.length && out[j] === out[i]) j++
    if (j - i < MIN) for (let k = i; k < j; k++) out[k] = null
    i = j
  }
  return out
}

export const DIFFICULTY_COLOR: Record<string, string> = {
  green: '#3aa14a',
  blue: '#2b7fff',
  red: '#e23b3b',
  black: '#111111',
}
