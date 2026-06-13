import type { Activity, MapStyleDef, RenderConfig } from './types'
import { sampleAt } from './metrics'
import { Timeline } from './timeline'
import {
  TILE,
  latToY,
  loadTile,
  lonToX,
  peekTile,
  styleById,
  tilesForView,
  zoomForBounds,
} from './tiles'
import { fmtDuration, widgetValue, type LiveSample } from './widgets'

export class Renderer {
  readonly canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private style: MapStyleDef
  private z = 1
  // Precomputed projected route points at current zoom (recomputed for follow).
  private projX: Float64Array
  private projY: Float64Array
  private lastProjZ = -1
  private lastT = 0
  private redrawQueued = false
  /** Called (coalesced) when async tiles arrive so a paused preview refreshes. */
  onTileLoad: (() => void) | null = null

  constructor(
    canvas: HTMLCanvasElement,
    private act: Activity,
    private cfg: RenderConfig,
    private timeline: Timeline,
  ) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas 2D not supported')
    this.ctx = ctx
    this.style = styleById(cfg.mapStyleId)
    canvas.width = cfg.width
    canvas.height = cfg.height
    this.projX = new Float64Array(act.points.length)
    this.projY = new Float64Array(act.points.length)
    this.computeZoom()
  }

  setConfig(cfg: RenderConfig) {
    this.cfg = cfg
    this.style = styleById(cfg.mapStyleId)
    this.canvas.width = cfg.width
    this.canvas.height = cfg.height
    this.lastProjZ = -1
    this.computeZoom()
  }

  setTimeline(t: Timeline) {
    this.timeline = t
  }

  private computeZoom() {
    if (this.cfg.camera === 'fit') {
      this.z = zoomForBounds(
        this.act.bbox,
        this.cfg.width,
        this.cfg.height,
        this.cfg.fitPadding,
        this.style.maxZoom,
      )
    } else {
      this.z = Math.min(this.style.maxZoom, Math.max(1, Math.round(this.cfg.followZoom)))
    }
  }

  /** Centre of the view (world px) for a given fractional index. */
  private centerFor(idx: number): { cx: number; cy: number } {
    if (this.cfg.camera === 'fit') {
      const [w, s, e, n] = this.act.bbox
      return {
        cx: (lonToX(w, this.z) + lonToX(e, this.z)) / 2,
        cy: (latToY(n, this.z) + latToY(s, this.z)) / 2,
      }
    }
    const p = sampleAt(this.act, idx)
    return { cx: lonToX(p.lon, this.z), cy: latToY(p.lat, this.z) }
  }

  private projectRoute() {
    if (this.lastProjZ === this.z) return
    for (let i = 0; i < this.act.points.length; i++) {
      this.projX[i] = lonToX(this.act.points[i].lon, this.z)
      this.projY[i] = latToY(this.act.points[i].lat, this.z)
    }
    this.lastProjZ = this.z
  }

  /** Collect every tile needed across the whole video (for preloading). */
  planTiles(): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = []
    const seen = new Set<string>()
    const add = (cx: number, cy: number) => {
      for (const t of tilesForView(cx, cy, this.z, this.cfg.width, this.cfg.height)) {
        const k = `${t.z}/${t.x}/${t.y}`
        if (!seen.has(k)) {
          seen.add(k)
          out.push({ x: t.x, y: t.y, z: t.z })
        }
      }
    }
    if (this.cfg.camera === 'fit') {
      const { cx, cy } = this.centerFor(0)
      add(cx, cy)
    } else {
      const vd = this.timeline.videoDuration
      const steps = Math.min(2000, Math.ceil(vd * 4))
      for (let i = 0; i <= steps; i++) {
        const idx = this.timeline.indexAtVideoTime((i / steps) * vd)
        const { cx, cy } = this.centerFor(idx)
        add(cx, cy)
      }
    }
    return out
  }

  private queueRedraw() {
    if (this.redrawQueued) return
    this.redrawQueued = true
    requestAnimationFrame(() => {
      this.redrawQueued = false
      if (this.onTileLoad) this.onTileLoad()
      else this.renderAt(this.lastT)
    })
  }

  renderAt(videoT: number) {
    this.lastT = videoT
    const idx = this.timeline.indexAtVideoTime(videoT)
    const { cx, cy } = this.centerFor(idx)
    const W = this.cfg.width
    const H = this.cfg.height
    const ctx = this.ctx
    const originX = cx - W / 2
    const originY = cy - H / 2

    // Background.
    ctx.fillStyle = this.style.dark ? '#0b0f14' : '#e8e8e8'
    ctx.fillRect(0, 0, W, H)

    // Tiles: draw what's cached now; trigger async load for anything missing
    // (preview fills in over a few frames; export preloads everything first).
    for (const t of tilesForView(cx, cy, this.z, W, H)) {
      const ready = peekTile(this.style, t.x, t.y, t.z)
      if (ready) ctx.drawImage(ready, Math.round(t.px), Math.round(t.py), TILE, TILE)
      else void loadTile(this.style, t.x, t.y, t.z).then((img) => { if (img) this.queueRedraw() })
    }

    this.projectRoute()
    this.drawRoute(originX, originY, idx)
    this.drawMarker(originX, originY, idx)
    this.drawOverlay(idx)
  }

  private drawRoute(ox: number, oy: number, idx: number) {
    const ctx = this.ctx
    const n = this.act.points.length
    const scale = Math.max(1, this.cfg.width / 1280)

    if (this.cfg.showFullRoute) {
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const x = this.projX[i] - ox
        const y = this.projY[i] - oy
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.lineWidth = this.cfg.trackWidth * scale + 2 * scale
      ctx.stroke()
      ctx.strokeStyle = this.cfg.trackColor
      ctx.globalAlpha = 0.45
      ctx.lineWidth = this.cfg.trackWidth * scale
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // Travelled portion.
    const upto = Math.floor(idx)
    ctx.beginPath()
    for (let i = 0; i <= upto && i < n; i++) {
      const x = this.projX[i] - ox
      const y = this.projY[i] - oy
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    // include the interpolated head
    const head = sampleAt(this.act, idx)
    ctx.lineTo(lonToX(head.lon, this.z) - ox, latToY(head.lat, this.z) - oy)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'
    ctx.lineWidth = this.cfg.trackWidth * scale + 3 * scale
    ctx.stroke()
    ctx.strokeStyle = this.cfg.accentColor
    ctx.lineWidth = this.cfg.trackWidth * scale
    ctx.stroke()
  }

  private drawMarker(ox: number, oy: number, idx: number) {
    const ctx = this.ctx
    const head = sampleAt(this.act, idx)
    const x = lonToX(head.lon, this.z) - ox
    const y = latToY(head.lat, this.z) - oy
    const scale = Math.max(1, this.cfg.width / 1280)
    const r = this.cfg.markerSize * scale

    ctx.save()
    ctx.shadowColor = this.cfg.accentColor
    ctx.shadowBlur = r * 1.5
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = this.cfg.accentColor
    ctx.fill()
    ctx.restore()

    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.lineWidth = 2 * scale
    ctx.strokeStyle = '#fff'
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y, r * 0.4, 0, Math.PI * 2)
    ctx.fillStyle = '#fff'
    ctx.fill()
  }

  // ---- Overlay (title, widgets, profile, attribution) ----
  private drawOverlay(idx: number) {
    const ctx = this.ctx
    const W = this.cfg.width
    const H = this.cfg.height
    const margin = Math.round(Math.min(W, H) * 0.035)
    const base = H / 36
    const p = sampleAt(this.act, idx)
    const live: LiveSample = {
      speed: p.speed,
      dist: p.dist,
      ele: p.ele,
      gain: p.gain,
      grade: p.grade,
      hr: p.hr,
      cad: p.cad,
      power: p.power,
      temp: p.temp,
      t: p.t,
    }

    let bottomY = H - margin
    const widgets = this.cfg.widgets

    if (widgets.includes('profile') && this.act.stats.hasEle) {
      const ph = Math.round(H * 0.12)
      const pw = W - margin * 2
      this.drawProfile(margin, bottomY - ph, pw, ph, idx)
      bottomY -= ph + margin * 0.6
    }

    // Stat chips, bottom-left row.
    const chips = widgets.filter((w) => w !== 'profile')
    if (chips.length) {
      const chipH = Math.round(base * 2.4)
      const gap = Math.round(margin * 0.4)
      let x = margin
      const y = bottomY - chipH
      ctx.font = `600 ${Math.round(base * 0.7)}px system-ui, sans-serif`
      for (const kind of chips) {
        const v = widgetValue(kind, live, this.act.stats, this.cfg.units)
        const valStr = v.unit ? `${v.value} ${v.unit}` : v.value
        ctx.font = `700 ${Math.round(base)}px system-ui, sans-serif`
        const valW = ctx.measureText(valStr).width
        ctx.font = `600 ${Math.round(base * 0.62)}px system-ui, sans-serif`
        const labW = ctx.measureText(v.label.toUpperCase()).width
        const cw = Math.max(valW, labW) + margin * 0.9
        if (x + cw > W - margin) break
        this.chip(x, y, cw, chipH, v.label.toUpperCase(), valStr, base)
        x += cw + gap
      }
    }

    // Title, top-left.
    if (this.cfg.showTitle && this.cfg.title) {
      const ts = Math.round(base * 1.3)
      ctx.font = `800 ${ts}px system-ui, sans-serif`
      const tw = ctx.measureText(this.cfg.title).width
      this.panel(margin, margin, tw + margin, ts + margin * 0.8)
      ctx.fillStyle = '#fff'
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      ctx.fillText(this.cfg.title, margin + margin * 0.5, margin + margin * 0.4)
      const sub = this.act.sport ? this.act.sport : ''
      if (sub) {
        ctx.font = `600 ${Math.round(base * 0.7)}px system-ui, sans-serif`
        ctx.fillStyle = 'rgba(255,255,255,0.75)'
        ctx.fillText(sub, margin + margin * 0.5, margin + margin * 0.4 + ts + 2)
      }
    }

    // Attribution, bottom-right.
    ctx.font = `${Math.round(base * 0.5)}px system-ui, sans-serif`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'
    const attr = this.style.attribution
    const aw = ctx.measureText(attr).width
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.fillRect(W - aw - 12, H - base * 0.9, aw + 12, base * 0.9)
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.fillText(attr, W - 6, H - 4)
    ctx.textAlign = 'left'
  }

  private chip(x: number, y: number, w: number, h: number, label: string, value: string, base: number) {
    const ctx = this.ctx
    this.panel(x, y, w, h)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    ctx.font = `600 ${Math.round(base * 0.62)}px system-ui, sans-serif`
    ctx.fillText(label, x + w * 0.12, y + h * 0.14)
    ctx.fillStyle = '#fff'
    ctx.font = `700 ${Math.round(base)}px system-ui, sans-serif`
    ctx.fillText(value, x + w * 0.12, y + h * 0.42)
  }

  private panel(x: number, y: number, w: number, h: number) {
    const ctx = this.ctx
    const r = Math.min(h * 0.25, 14)
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
    ctx.fillStyle = 'rgba(15,20,26,0.62)'
    ctx.fill()
  }

  private drawProfile(x: number, y: number, w: number, h: number, idx: number) {
    const ctx = this.ctx
    const d = this.act.derived
    const n = d.length
    const minE = this.act.stats.minEle ?? 0
    const maxE = this.act.stats.maxEle ?? 1
    const range = Math.max(1, maxE - minE)
    this.panel(x, y, w, h)
    const padX = w * 0.02
    const padY = h * 0.18
    const gx = x + padX
    const gw = w - padX * 2
    const gy = y + padY
    const gh = h - padY * 2

    const eleAt = (i: number) => {
      const e = this.act.points[i].ele ?? minE
      return gy + gh - ((e - minE) / range) * gh
    }
    // Filled area.
    ctx.beginPath()
    ctx.moveTo(gx, gy + gh)
    for (let i = 0; i < n; i++) {
      ctx.lineTo(gx + (d[i].dist / this.act.stats.totalDistance) * gw, eleAt(i))
    }
    ctx.lineTo(gx + gw, gy + gh)
    ctx.closePath()
    ctx.fillStyle = 'rgba(255,255,255,0.18)'
    ctx.fill()

    // Travelled overlay up to idx.
    const headDist = sampleAt(this.act, idx).dist
    const headX = gx + (headDist / this.act.stats.totalDistance) * gw
    ctx.save()
    ctx.beginPath()
    ctx.rect(gx, y, headX - gx, h)
    ctx.clip()
    ctx.beginPath()
    ctx.moveTo(gx, gy + gh)
    for (let i = 0; i < n; i++) {
      ctx.lineTo(gx + (d[i].dist / this.act.stats.totalDistance) * gw, eleAt(i))
    }
    ctx.lineTo(gx + gw, gy + gh)
    ctx.closePath()
    ctx.fillStyle = this.cfg.accentColor
    ctx.globalAlpha = 0.55
    ctx.fill()
    ctx.restore()
    ctx.globalAlpha = 1

    // Position marker.
    ctx.beginPath()
    ctx.moveTo(headX, gy - 2)
    ctx.lineTo(headX, gy + gh + 2)
    ctx.strokeStyle = this.cfg.accentColor
    ctx.lineWidth = 2
    ctx.stroke()

    // Gain label.
    ctx.fillStyle = 'rgba(255,255,255,0.8)'
    ctx.font = `600 ${Math.round(h * 0.16)}px system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(`▲ ${Math.round(this.act.stats.totalGain)} m`, gx + 4, y + 4)
    ctx.textAlign = 'right'
    ctx.fillText(fmtDuration(this.timeline.realDuration), x + w - 4, y + 4)
    ctx.textAlign = 'left'
  }
}
