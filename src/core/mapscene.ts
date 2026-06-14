import maplibregl from 'maplibre-gl'
import type { Activity, RenderConfig } from './types'
import type { Timeline } from './timeline'
import { styleById } from './tiles'
import { DIFFICULTY_COLOR, type PistaTrails } from '../pista'

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
  // Pista trails overlay.
  private pistaInfo: Record<string, { name: string; difficulty: string | null }> = {}
  private pistaMatched: (string | null)[] = []
  private currentTrailId: string | null = null
  private _currentTrail: { name: string; difficulty: string | null } | null = null

  constructor(
    container: HTMLElement,
    act: Activity,
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
        this.applyMarkerIcon()
        resolve()
      })
    })
  }

  /** Intro duration (0 when disabled). */
  get introDuration(): number {
    return this.cfg.showIntro ? Math.max(0, this.cfg.introDuration) : 0
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
    const prevPista = this.cfg.showPistaTrails
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
    if (this.map.isStyleLoaded()) this.applyMarkerIcon()
    if (cfg.showPistaTrails !== prevPista) this.renderPista()
    this.fitCam = null // recompute fit camera (padding/size may have changed)
  }

  /** Swap the marker between the dot and an emoji icon (rendered as a map image). */
  private applyMarkerIcon() {
    const icon = this.cfg.markerIcon
    const useIcon = !!icon && icon !== 'dot'
    this.map.setLayoutProperty('head', 'visibility', useIcon ? 'none' : 'visible')
    this.map.setLayoutProperty('head-glow', 'visibility', useIcon ? 'none' : 'visible')
    if (useIcon) {
      const id = 'mk-' + Array.from(icon).map((c) => c.codePointAt(0)!.toString(16)).join('-')
      if (!this.map.hasImage(id)) {
        const img = emojiToImageData(icon, 128)
        if (img) this.map.addImage(id, img, { pixelRatio: 2 })
      }
      const size = this.cfg.markerSize / 7
      if (!this.map.getLayer('head-icon')) {
        this.map.addLayer({
          id: 'head-icon',
          type: 'symbol',
          source: 'head',
          layout: {
            'icon-image': id,
            'icon-size': size,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          },
        })
      } else {
        this.map.setLayoutProperty('head-icon', 'icon-image', id)
        this.map.setLayoutProperty('head-icon', 'icon-size', size)
        this.map.setLayoutProperty('head-icon', 'visibility', 'visible')
      }
    } else if (this.map.getLayer('head-icon')) {
      this.map.setLayoutProperty('head-icon', 'visibility', 'none')
    }
  }

  /** Camera for the start of the main animation (intro eases toward this). */
  private startCamera() {
    return {
      center: [this.interpArr(this.smoothLng, 0), this.interpArr(this.smoothLat, 0)] as LngLat,
      zoom: this.cfg.followZoom,
      pitch: this.cfg.terrain3d ? this.cfg.pitch : 0,
      bearing: this.cfg.rotateWithHeading ? this.interpArr(this.smoothBearing, 0) : 0,
    }
  }

  /** Intro fly-in: ease from far above the planet down to the start camera. */
  private seekIntro(p: number) {
    const e = p * p * p * (p * (p * 6 - 15) + 10) // smootherstep
    const to = this.startCamera()
    const fromZoom = 2.2
    ;(this.map.getSource('travelled') as maplibregl.GeoJSONSource).setData(this.lineFeature([this.coords[0], this.coords[0]]))
    ;(this.map.getSource('head') as maplibregl.GeoJSONSource).setData(this.pointFeature(to.center))
    this.map.jumpTo({
      center: to.center,
      zoom: fromZoom + (to.zoom - fromZoom) * e,
      pitch: to.pitch * e,
      bearing: to.bearing * e,
    })
  }

  setTimeline(t: Timeline) {
    this.timeline = t
  }

  /** Provide (or clear) the nearby Pista trails to overlay + match against. */
  setPista(pt: PistaTrails | null) {
    this.pistaData = pt
    this.renderPista()
  }

  private pistaData: PistaTrails | null = null

  private renderPista() {
    for (const id of ['pista-hl', 'pista-trails']) if (this.map.getLayer(id)) this.map.removeLayer(id)
    if (this.map.getSource('pista')) this.map.removeSource('pista')
    this.pistaInfo = {}
    this.pistaMatched = []
    this.currentTrailId = null
    this._currentTrail = null
    const pt = this.pistaData
    if (!pt || !this.cfg.showPistaTrails) return
    this.pistaInfo = pt.info
    this.pistaMatched = pt.matched
    this.map.addSource('pista', { type: 'geojson', data: pt.geojson as GeoJSON.GeoJSON })
    const before = this.map.getLayer('route') ? 'route' : undefined
    const diffColor: maplibregl.ExpressionSpecification = [
      'match', ['get', 'difficulty'],
      'green', DIFFICULTY_COLOR.green, 'blue', DIFFICULTY_COLOR.blue,
      'red', DIFFICULTY_COLOR.red, 'black', DIFFICULTY_COLOR.black,
      this.cfg.accentColor,
    ]
    this.map.addLayer(
      {
        id: 'pista-trails',
        type: 'line',
        source: 'pista',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': diffColor, 'line-width': 2, 'line-opacity': 0.35 },
      },
      before,
    )
    this.map.addLayer(
      {
        id: 'pista-hl',
        type: 'line',
        source: 'pista',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        filter: ['==', ['get', 'id'], '__none__'],
        paint: { 'line-color': diffColor, 'line-width': this.cfg.trackWidth + 3, 'line-opacity': 0.95 },
      },
      before,
    )
  }

  private updateTrail(idx: number) {
    const id =
      idx >= 0 && this.pistaMatched.length ? this.pistaMatched[Math.round(idx)] ?? null : null
    if (id === this.currentTrailId) return
    this.currentTrailId = id
    this._currentTrail = id ? this.pistaInfo[id] ?? null : null
    if (this.map.getLayer('pista-hl')) this.map.setFilter('pista-hl', ['==', ['get', 'id'], id ?? '__none__'])
  }

  /** Name + difficulty of the Pista trail the rider is currently on (or null). */
  get currentTrail(): { name: string; difficulty: string | null } | null {
    return this._currentTrail
  }

  /**
   * Precompute heavily-smoothed camera tracks so the follow camera glides
   * instead of snapping: bearings are unwrapped then moving-averaged (kills the
   * jerk on switchbacks / GPS noise), and the camera centre is lightly smoothed.
   */
  private buildSmoothTracks() {
    const n = this.coords.length
    const lng = this.coords.map((c) => c[0])
    const lat = this.coords.map((c) => c[1])

    // MACRO trajectory: heavily smoothed so dense switchbacks collapse into the
    // general direction of travel. Bearing read from this points "west" the whole
    // way down a west-bound switchback piste, and only reverses when the rider
    // genuinely doubles back (the macro path itself reverses).
    const macroWin = Math.min(260, Math.max(20, Math.round(n * 0.08)))
    const mLng = movAvgArr(lng, macroWin)
    const mLat = movAvgArr(lat, macroWin)
    const look = Math.min(120, Math.max(6, Math.round(n * 0.04)))
    const raw = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - look)
      const b = Math.min(n - 1, i + look)
      raw[i] = bearingLL(mLng[a], mLat[a], mLng[b], mLat[b])
    }
    // Unwrap so averaging doesn't break at the 360→0 seam.
    const unwrapped = new Float64Array(n)
    unwrapped[0] = raw[0]
    for (let i = 1; i < n; i++) {
      let d = raw[i] - raw[i - 1]
      d = (((d + 180) % 360) + 360) % 360 - 180
      unwrapped[i] = unwrapped[i - 1] + d
    }
    const bWin = Math.min(160, Math.max(11, Math.round(n * 0.05)))
    // POSITION for marker + camera: lightly smoothed only (kills GPS jitter, keeps
    // the point on the track) so the dot glides instead of stepping.
    const pWin = Math.min(15, Math.max(3, Math.round(n * 0.01)))
    return {
      bearing: movAvg(unwrapped, bWin),
      lng: movAvgArr(lng, pWin),
      lat: movAvgArr(lat, pWin),
    }
  }

  private interpArr(arr: Float64Array, idx: number): number {
    const i0 = Math.max(0, Math.min(arr.length - 1, Math.floor(idx)))
    const i1 = Math.min(arr.length - 1, i0 + 1)
    return arr[i0] + (arr[i1] - arr[i0]) * (idx - i0)
  }

  get outroDuration(): number {
    return this.cfg.showOutro ? Math.max(0, this.cfg.outroDuration) : 0
  }

  /** Camera framing the whole route (cached); pitch flattened a bit. */
  private getFitCam(): { center: LngLat; zoom: number } {
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
    return this.fitCam
  }

  /** Outro: ease from the end-of-ride follow camera out to frame the whole route. */
  private seekOutro(p: number) {
    const e = p * p * p * (p * (p * 6 - 15) + 10)
    const last = this.coords.length - 1
    const from = {
      lng: this.interpArr(this.smoothLng, last),
      lat: this.interpArr(this.smoothLat, last),
      zoom: this.cfg.followZoom,
      pitch: this.cfg.terrain3d ? this.cfg.pitch : 0,
      bearing: this.cfg.rotateWithHeading ? this.interpArr(this.smoothBearing, last) : 0,
    }
    const fit = this.getFitCam()
    const toZoom = fit.zoom - 0.5 // extra breathing room around the route
    const toPitch = this.cfg.terrain3d ? Math.min(this.cfg.pitch, 35) : 0
    // Full route revealed, marker at the finish.
    ;(this.map.getSource('travelled') as maplibregl.GeoJSONSource).setData(this.lineFeature(this.coords))
    ;(this.map.getSource('head') as maplibregl.GeoJSONSource).setData(
      this.pointFeature([from.lng, from.lat]),
    )
    this.map.jumpTo({
      center: [from.lng + (fit.center[0] - from.lng) * e, from.lat + (fit.center[1] - from.lat) * e],
      zoom: from.zoom + (toZoom - from.zoom) * e,
      pitch: from.pitch + (toPitch - from.pitch) * e,
      bearing: from.bearing * (1 - e),
    })
  }

  /** Position the map + route reveal for a given video time (intro + outro incl.). */
  seek(videoT: number) {
    const intro = this.introDuration
    if (intro > 0 && videoT < intro) {
      this.updateTrail(-1)
      this.seekIntro(Math.max(0, videoT / intro))
      return
    }
    const main = this.timeline.videoDuration
    const afterIntro = videoT - intro
    if (this.outroDuration > 0 && afterIntro > main) {
      this.updateTrail(-1)
      this.seekOutro(Math.min(1, (afterIntro - main) / this.outroDuration))
      return
    }
    const idx = this.timeline.indexAtVideoTime(afterIntro)
    this.updateTrail(idx)
    // Smoothed marker position: glides along the track (no GPS step jitter) and
    // stays locked to the camera centre.
    const headLngLat: LngLat = [this.interpArr(this.smoothLng, idx), this.interpArr(this.smoothLat, idx)]

    const upto = Math.floor(idx)
    const travelled = this.coords.slice(0, upto + 1)
    travelled.push(headLngLat)
    if (travelled.length < 2) travelled.unshift(this.coords[0])
    ;(this.map.getSource('travelled') as maplibregl.GeoJSONSource).setData(this.lineFeature(travelled))
    ;(this.map.getSource('head') as maplibregl.GeoJSONSource).setData(this.pointFeature(headLngLat))

    if (this.cfg.camera === 'follow') {
      // Camera glides on the smoothed centre; bearing follows the MACRO heading
      // (steady through switchbacks, half-turns only on a real direction reversal)
      // when enabled, else steady north-up.
      this.map.jumpTo({
        center: headLngLat,
        zoom: this.cfg.followZoom,
        pitch: this.cfg.terrain3d ? this.cfg.pitch : 0,
        bearing: this.cfg.rotateWithHeading ? this.interpArr(this.smoothBearing, idx) : 0,
      })
    } else {
      const fit = this.getFitCam()
      this.map.jumpTo({
        center: fit.center,
        zoom: fit.zoom,
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

/** Initial bearing (deg) from point A to point B. */
function bearingLL(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const Δλ = ((lon2 - lon1) * Math.PI) / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/** Rasterise an emoji into ImageData so it can be a MapLibre marker image. */
function emojiToImageData(emoji: string, size: number): ImageData | null {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.font = `${Math.round(size * 0.78)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(emoji, size / 2, size * 0.54)
  return ctx.getImageData(0, 0, size, size)
}
