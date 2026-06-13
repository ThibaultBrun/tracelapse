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

  constructor(
    container: HTMLElement,
    private act: Activity,
    private cfg: RenderConfig,
    private timeline: Timeline,
  ) {
    this.coords = act.points.map((p) => [p.lon, p.lat] as LngLat)
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

  /** Travel direction (bearing in degrees) around a fractional index. */
  private bearingAt(idx: number): number {
    const n = this.coords.length
    const i = Math.max(0, Math.min(n - 2, Math.floor(idx)))
    const ahead = Math.min(n - 1, i + Math.max(1, Math.round(n * 0.01)))
    const [lon1, lat1] = this.coords[i]
    const [lon2, lat2] = this.coords[ahead]
    const φ1 = (lat1 * Math.PI) / 180
    const φ2 = (lat2 * Math.PI) / 180
    const Δλ = ((lon2 - lon1) * Math.PI) / 180
    const y = Math.sin(Δλ) * Math.cos(φ2)
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
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
      this.map.jumpTo({
        center: headLngLat,
        zoom: this.cfg.followZoom,
        pitch: this.cfg.terrain3d ? this.cfg.pitch : 0,
        bearing: this.cfg.terrain3d ? this.bearingAt(idx) : 0,
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
