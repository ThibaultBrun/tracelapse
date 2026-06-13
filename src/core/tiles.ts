import type { MapStyleDef } from './types'

export const MAP_STYLES: MapStyleDef[] = [
  {
    id: 'osm',
    label: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    dark: false,
    maxZoom: 19,
  },
  {
    id: 'topo',
    label: 'OpenTopoMap',
    url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '© OpenTopoMap (CC-BY-SA) · © OpenStreetMap',
    dark: false,
    maxZoom: 17,
  },
  {
    id: 'sat',
    label: 'Satellite (Esri)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    dark: true,
    maxZoom: 19,
  },
  {
    id: 'dark',
    label: 'Carto Dark',
    url: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    attribution: '© CARTO · © OpenStreetMap',
    dark: true,
    maxZoom: 20,
  },
  {
    id: 'light',
    label: 'Carto Light',
    url: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    attribution: '© CARTO · © OpenStreetMap',
    dark: false,
    maxZoom: 20,
  },
  {
    id: 'voyager',
    label: 'Carto Voyager',
    url: 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
    attribution: '© CARTO · © OpenStreetMap',
    dark: false,
    maxZoom: 20,
  },
]

export const TILE = 256

export function styleById(id: string): MapStyleDef {
  return MAP_STYLES.find((s) => s.id === id) ?? MAP_STYLES[0]
}

/** Web Mercator projection: lon/lat -> world pixel coords at a given zoom. */
export function lonToX(lon: number, z: number): number {
  return ((lon + 180) / 360) * TILE * 2 ** z
}

export function latToY(lat: number, z: number): number {
  const s = Math.sin((lat * Math.PI) / 180)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z
}

/** Pick the highest integer zoom at which the bbox fits within w×h (with padding). */
export function zoomForBounds(
  bbox: [number, number, number, number],
  width: number,
  height: number,
  padding: number,
  maxZoom: number,
): number {
  const [w, s, e, n] = bbox
  const usableW = width * (1 - padding)
  const usableH = height * (1 - padding)
  for (let z = maxZoom; z >= 1; z--) {
    const dx = Math.abs(lonToX(e, z) - lonToX(w, z))
    const dy = Math.abs(latToY(s, z) - latToY(n, z))
    if (dx <= usableW && dy <= usableH) return z
  }
  return 1
}

const cache = new Map<string, HTMLImageElement>()
const pending = new Map<string, Promise<HTMLImageElement | null>>()

function tileUrl(style: MapStyleDef, x: number, y: number, z: number): string {
  const max = 2 ** z
  const wrappedX = ((x % max) + max) % max
  return style.url
    .replace('{z}', String(z))
    .replace('{x}', String(wrappedX))
    .replace('{y}', String(y))
}

/** Load a single tile as a CORS-clean image (so the canvas stays exportable). */
export function loadTile(
  style: MapStyleDef,
  x: number,
  y: number,
  z: number,
): Promise<HTMLImageElement | null> {
  if (y < 0 || y >= 2 ** z) return Promise.resolve(null)
  const url = tileUrl(style, x, y, z)
  const hit = cache.get(url)
  if (hit) return Promise.resolve(hit)
  const inflight = pending.get(url)
  if (inflight) return inflight
  const p = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      cache.set(url, img)
      pending.delete(url)
      resolve(img)
    }
    img.onerror = () => {
      pending.delete(url)
      resolve(null)
    }
    img.src = url
  })
  pending.set(url, p)
  return p
}

/** Synchronous cache lookup — returns a ready tile image or null. */
export function peekTile(
  style: MapStyleDef,
  x: number,
  y: number,
  z: number,
): HTMLImageElement | null {
  if (y < 0 || y >= 2 ** z) return null
  return cache.get(tileUrl(style, x, y, z)) ?? null
}

/** Compute the set of tiles covering a pixel viewport centred on world coords. */
export function tilesForView(
  centerWX: number,
  centerWY: number,
  z: number,
  width: number,
  height: number,
): { x: number; y: number; z: number; px: number; py: number }[] {
  const left = centerWX - width / 2
  const top = centerWY - height / 2
  const x0 = Math.floor(left / TILE)
  const y0 = Math.floor(top / TILE)
  const x1 = Math.floor((left + width) / TILE)
  const y1 = Math.floor((top + height) / TILE)
  const out: { x: number; y: number; z: number; px: number; py: number }[] = []
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      out.push({ x: tx, y: ty, z, px: tx * TILE - left, py: ty * TILE - top })
    }
  }
  return out
}

/** Preload every tile needed to render the whole animation (so export has no blanks). */
export async function preloadTiles(
  style: MapStyleDef,
  tiles: { x: number; y: number; z: number }[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const seen = new Set<string>()
  const unique = tiles.filter((t) => {
    const k = `${t.z}/${t.x}/${t.y}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  let done = 0
  const CONCURRENCY = 6
  let idx = 0
  async function worker() {
    while (idx < unique.length) {
      const t = unique[idx++]
      await loadTile(style, t.x, t.y, t.z)
      done++
      onProgress?.(done, unique.length)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
}
