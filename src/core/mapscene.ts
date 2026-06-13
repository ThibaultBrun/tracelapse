import maplibregl from 'maplibre-gl'
import type { Activity, RenderConfig } from './types'
import type { Timeline } from './timeline'
import { sampleAt } from './metrics'
import { styleById } from './tiles'

// Public Terrarium DEM (CORS-enabled) — works same on the VPS alias and GH Pages.
const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
const DEM_ATTRIB = 'Terrain: Mapzen / AWS'

type LngLat = [number, number]

export class MapScene {
  readonly map: maplibregl.Map
  readonly ready: Promise<void>
  private coords: LngLat[]
  private fitCam: { center: LngLat; zoom: number } | null = null
  // Smoothed camera tracks (deterministic per index → safe for scrub & export).
  private smoothBearing: Float64Array // unwrapped, can exceed [0,360)
  private smoothLng: Float64Array
  private smoothLat: Float64Array

  constructor(
    container: HTMLElement,
    private act: Activity,
    private cfg: RenderConfig,
    private timeline: Timeline,
  ) {
    this.coords = act.points.map((p) => [p.lon, p.lat] as LngLat)
    const tracks = this.buildSmoothTracks()
    this.smoothBearing = tracks.bearing
    this.smoothLng = tracks.lng
    this.smoothLat = tracks.lat
    const style = styleById(cfg.mapStyleId)
    const start = this.coords[0]

    this.map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        sources: {
          base: {
            type: 'raster',
            tiles: [style.url],
            tileSize: 256,
            maxzoom: style.maxZoom,
            attribution: style.attribution,
          },
          dem: { type: 'raster-dem', tiles: [DEM_URL], tileSize: 256, encoding: 'terrarium', maxzoom: 15 },
          route: { type: 'geojson', data: this.lineFeature(this.coords) },
          travelled: { type: 'geojson', data: this.lineFeature([start, start]) },
          head: { type: 'geojson', data: this.pointFeature(start) },
        },
        layers: [
          { id: 'base', type: 'raster', source: 'base' },
          {
            id: 'route',
            type: 'line',
            source: 'route',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': cfg.trackColor, 'line-width': cfg.trackWidth, 'line-opacity': 0.45 },
          },
          {
            id: 'travelled',
            type: 'line',
            source: 'travelled',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': cfg.accentColor, 'line-width': cfg.trackWidth + 1 },
          },
          {
            id: 'head-glow',
            type: 'circle',
            source: 'head',
            paint: {
              'circle-radius': cfg.markerSize + 5,
              'circle-color': cfg.accentColor,
              'circle-opacity': 0.35,
              'circle-blur': 0.6,
            },
          },
          {
            id: 'head',
            type: 'circle',
            source: 'head',
            paint: {
              'circle-radius': cfg.markerSize,
              'circle-color': cfg.accentColor,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            },
          },
        ],
      },
      center: start,
      zoom: cfg.followZoom,
      pitch: cfg.terrain3d ? cfg.pitch : 0,
      bearing: 0,
      attributionControl: false,
      interactive: false,
      preserveDrawingBuffer: true, // required to read the canvas back for export
      fadeDuration: 0,
      maxPitch: 80,
    })

    this.ready = new Promise((resolve) => {
      this.map.on('load', () => {
        if (cfg.terrain3d) this.map.setTerrain({ source: 'dem', exaggeration: cfg.terrainExaggeration })
        resolve()
      })
    })
  }

  get attribution(): string {
    return `${styleById(this.cfg.mapStyleId).attribution} · ${DEM_ATTRIB}`
  }

  private lineFeature(coords: LngLat[]): GeoJSON.Feature {
    return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }
  }
  private pointFeature(c: LngLat): GeoJSON.Feature {
    return { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }
  }

  setConfig(cfg: RenderConfig) {
    const prevStyle = this.cfg.mapStyleId
    this.cfg = cfg
    const style = styleById(cfg.mapStyleId)
    if (cfg.mapStyleId !== prevStyle) {
      const src = this.map.getSource('base') as maplibregl.RasterTileSource
      src.setTiles([style.url])
    }
    this.map.setPaintProperty('route', 'line-color', cfg.trackColor)
    this.map.setPaintProperty('route', 'line-width', cfg.trackWidth)
    this.map.setPaintProperty('travelled', 'line-color', cfg.accentColor)
    this.map.setPaintProperty('travelled', 'line-width', cfg.trackWidth + 1)
    this.map.setPaintProperty('head', 'circle-radius', cfg.markerSize)
    this.map.setPaintProperty('head', 'circle-color', cfg.accentColor)
    this.map.setPaintProperty('head', 'circle-stroke-color', '#ffffff')
    this.map.setPaintProperty('head-glow', 'circle-radius', cfg.markerSize + 5)
    this.map.setPaintProperty('head-glow', 'circle-color', cfg.accentColor)
    this.map.setTerrain(cfg.terrain3d ? { source: 'dem', exaggeration: cfg.terrainExaggeration } : null)
    this.fitCam = null // recompute fit camera (padding/size may have changed)
  }

  setTimeline(t: Timeline) {
    this.timeline = t
  }

  /**
   * Precompute heavily-smoothed camera tracks so the follow camera glides
   * instead of snapping: bearings are unwrapped then moving-averaged (kills the
   * jerk on switchbacks / GPS noise), and the camera centre is lightly smoothed.
   */
  private buildSmoothTracks() {
    const n = this.coords.length
    // Heading from a long look-ahead chord (direction toward a point ~ahead),
    // not between adjacent points — a wiggly/noisy path then reads as one
    // smooth general direction instead of constant micro-corrections.
    const look = Math.min(80, Math.max(4, Math.round(n * 0.05)))
    const raw = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - Math.round(look / 2))
      const b = Math.min(n - 1, i + Math.round(look / 2))
      raw[i] = this.rawBearing(a, b === a ? Math.min(n - 1, a + 1) : b)
    }
    // Unwrap to a continuous angle so averaging doesn't break at the 360→0 seam.
    const unwrapped = new Float64Array(n)
    unwrapped[0] = raw[0]
    for (let i = 1; i < n; i++) {
      let d = raw[i] - raw[i - 1]
      d = (((d + 180) % 360) + 360) % 360 - 180
      unwrapped[i] = unwrapped[i - 1] + d
    }
    const bWin = Math.min(200, Math.max(15, Math.round(n * 0.1)))
    const cWin = Math.min(24, Math.max(3, Math.round(n * 0.008)))
    const lng = this.coords.map((c) => c[0])
    const lat = this.coords.map((c) => c[1])
    // Two averaging passes for an extra-smooth, "asservi" glide.
    return {
      bearing: movAvg(movAvg(unwrapped, bWin), bWin),
      lng: movAvgArr(lng, cWin),
      lat: movAvgArr(lat, cWin),
    }
  }

  private rawBearing(i: number, j: number): number {
    const [lon1, lat1] = this.coords[i]
    const [lon2, lat2] = this.coords[j]
    const φ1 = (lat1 * Math.PI) / 180
    const φ2 = (lat2 * Math.PI) / 180
    const Δλ = ((lon2 - lon1) * Math.PI) / 180
    const y = Math.sin(Δλ) * Math.cos(φ2)
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
  }

  private interpArr(arr: Float64Array, idx: number): number {
    const i0 = Math.max(0, Math.min(arr.length - 1, Math.floor(idx)))
    const i1 = Math.min(arr.length - 1, i0 + 1)
    return arr[i0] + (arr[i1] - arr[i0]) * (idx - i0)
  }

  /** Position the map + route reveal for a given video time. */
  seek(videoT: number) {
    const idx = this.timeline.indexAtVideoTime(videoT)
    const head = sampleAt(this.act, idx)
    const headLngLat: LngLat = [head.lon, head.lat]

    const upto = Math.floor(idx)
    const travelled = this.coords.slice(0, upto + 1)
    travelled.push(headLngLat)
    if (travelled.length < 2) travelled.unshift(this.coords[0])
    ;(this.map.getSource('travelled') as maplibregl.GeoJSONSource).setData(this.lineFeature(travelled))
    ;(this.map.getSource('head') as maplibregl.GeoJSONSource).setData(this.pointFeature(headLngLat))

    if (this.cfg.camera === 'follow') {
      // Camera follows a smoothed centre + bearing (the marker stays on the
      // exact track); gives an "asservi", gliding chase-cam instead of snapping.
      this.map.jumpTo({
        center: [this.interpArr(this.smoothLng, idx), this.interpArr(this.smoothLat, idx)],
        zoom: this.cfg.followZoom,
        pitch: this.cfg.terrain3d ? this.cfg.pitch : 0,
        bearing: this.cfg.terrain3d ? this.interpArr(this.smoothBearing, idx) : 0,
      })
    } else {
      if (!this.fitCam) {
        const b = new maplibregl.LngLatBounds(this.coords[0], this.coords[0])
        for (const c of this.coords) b.extend(c)
        const cam = this.map.cameraForBounds(b, { padding: Math.round(this.map.getCanvas().width * this.cfg.fitPadding) })
        if (cam && cam.center) {
          const c = maplibregl.LngLat.convert(cam.center)
          this.fitCam = { center: [c.lng, c.lat], zoom: cam.zoom ?? this.cfg.followZoom }
        } else {
          this.fitCam = { center: this.coords[0], zoom: this.cfg.followZoom }
        }
      }
      this.map.jumpTo({
        center: this.fitCam.center,
        zoom: this.fitCam.zoom,
        pitch: this.cfg.terrain3d ? Math.min(this.cfg.pitch, 50) : 0,
        bearing: 0,
      })
    }
  }

  /**
   * Capture the map into a 2D context, reading the WebGL canvas *synchronously
   * inside the 'render' event* — the only moment the drawing buffer is
   * guaranteed valid when preserveDrawingBuffer isn't honoured (e.g. software
   * GL). Resolves once a frame with all tiles loaded has been copied.
   */
  captureInto(ctx: CanvasRenderingContext2D, dw: number, dh: number, timeoutMs = 4000): Promise<void> {
    return new Promise((resolve) => {
      let done = false
      const grab = () => {
        ctx.drawImage(this.map.getCanvas(), 0, 0, dw, dh)
        done = true
        clearTimeout(t)
        this.map.off('render', onRender)
        resolve()
      }
      const onRender = () => {
        if (done) return
        if (this.map.areTilesLoaded()) grab()
      }
      const t = setTimeout(() => {
        if (!done) grab()
      }, timeoutMs)
      this.map.on('render', onRender)
      this.map.triggerRepaint()
    })
  }

  /** Resolve once a fully-loaded frame has painted (no capture). */
  renderSettled(timeoutMs = 4000): Promise<void> {
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(t)
        this.map.off('render', onRender)
        resolve()
      }
      const onRender = () => {
        if (this.map.areTilesLoaded()) finish()
      }
      const t = setTimeout(finish, timeoutMs)
      this.map.on('render', onRender)
      this.map.triggerRepaint()
    })
  }

  resize() {
    this.map.resize()
  }

  destroy() {
    this.map.remove()
  }
}

/** Centred moving average over a Float64Array (window = ±half). */
function movAvg(arr: Float64Array, win: number): Float64Array {
  const out = new Float64Array(arr.length)
  const half = Math.floor(win / 2)
  for (let i = 0; i < arr.length; i++) {
    let sum = 0
    let cnt = 0
    for (let j = Math.max(0, i - half); j <= Math.min(arr.length - 1, i + half); j++) {
      sum += arr[j]
      cnt++
    }
    out[i] = sum / cnt
  }
  return out
}

function movAvgArr(arr: number[], win: number): Float64Array {
  return movAvg(Float64Array.from(arr), win)
}
