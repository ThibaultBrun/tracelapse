import type { TrackPoint } from './types'

/**
 * Parse a GPX or TCX document into raw track points.
 * Supports Garmin TrackPointExtension (hr, cad, atemp, power) and the
 * common `power` / `gpxpx` namespaces, plus Strava/Garmin TCX exports.
 */
export function parseTrack(text: string, fileName: string): {
  name: string
  sport: string | null
  points: TrackPoint[]
} {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  const err = doc.querySelector('parsererror')
  if (err) throw new Error('Invalid XML / GPX file')

  const root = doc.documentElement.nodeName.toLowerCase()
  if (root.includes('trainingcenterdatabase')) return parseTcx(doc, fileName)
  return parseGpx(doc, fileName)
}

function num(v: string | null | undefined): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function text(el: Element | null, sel: string): string | null {
  if (!el) return null
  // querySelector with namespaced tags is unreliable across browsers, so we
  // match by local name.
  const found = firstByLocalName(el, sel)
  return found?.textContent ?? null
}

function firstByLocalName(el: Element, local: string): Element | null {
  const all = el.getElementsByTagName('*')
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === local) return all[i]
  }
  return null
}

function parseGpx(doc: Document, fileName: string): {
  name: string
  sport: string | null
  points: TrackPoint[]
} {
  const trkpts = Array.from(doc.getElementsByTagName('*')).filter(
    (e) => e.localName === 'trkpt' || e.localName === 'rtept',
  )
  const points: TrackPoint[] = []
  for (const pt of trkpts) {
    const lat = num(pt.getAttribute('lat'))
    const lon = num(pt.getAttribute('lon'))
    if (lat == null || lon == null) continue
    const timeStr = text(pt, 'time')
    points.push({
      lat,
      lon,
      ele: num(text(pt, 'ele')),
      time: timeStr ? Date.parse(timeStr) || null : null,
      hr: num(text(pt, 'hr')),
      cad: num(text(pt, 'cad')),
      power: num(text(pt, 'power')) ?? num(text(pt, 'pwr')),
      temp: num(text(pt, 'atemp')) ?? num(text(pt, 'temp')),
    })
  }
  const name =
    text(doc.documentElement, 'name') ?? stripExt(fileName)
  const sport = detectSport(text(doc.documentElement, 'type'))
  return { name, sport, points }
}

function parseTcx(doc: Document, fileName: string): {
  name: string
  sport: string | null
  points: TrackPoint[]
} {
  const tps = Array.from(doc.getElementsByTagName('*')).filter(
    (e) => e.localName === 'Trackpoint',
  )
  const points: TrackPoint[] = []
  for (const tp of tps) {
    const lat = num(text(tp, 'LatitudeDegrees'))
    const lon = num(text(tp, 'LongitudeDegrees'))
    if (lat == null || lon == null) continue
    const timeStr = text(tp, 'Time')
    points.push({
      lat,
      lon,
      ele: num(text(tp, 'AltitudeMeters')),
      time: timeStr ? Date.parse(timeStr) || null : null,
      // TCX wraps HR as <HeartRateBpm><Value>120</Value></HeartRateBpm>;
      // textContent of HeartRateBpm yields the inner number directly.
      hr: num(text(tp, 'HeartRateBpm')),
      cad: num(text(tp, 'Cadence')),
      power: num(text(tp, 'Watts')),
      temp: null,
    })
  }
  const activity = Array.from(doc.getElementsByTagName('*')).find(
    (e) => e.localName === 'Activity',
  )
  const sport = detectSport(activity?.getAttribute('Sport') ?? null)
  return { name: stripExt(fileName), sport, points }
}

function detectSport(raw: string | null): string | null {
  if (!raw) return null
  const s = raw.toLowerCase()
  if (s.includes('run')) return 'Running'
  if (s.includes('bik') || s.includes('cycl') || s.includes('ride')) return 'Cycling'
  if (s.includes('hik') || s.includes('walk')) return 'Hiking'
  if (s.includes('swim')) return 'Swimming'
  return raw
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}
