import type { Activity, RenderConfig } from './types'
import type { Timeline } from './timeline'
import { sampleAt } from './metrics'
import { fmtDuration, widgetValue, type LiveSample } from './widgets'

export interface OverlayCtx {
  act: Activity
  cfg: RenderConfig
  timeline: Timeline
  attribution: string
}

/**
 * Draw the data overlay (title, widget chips, elevation profile, attribution)
 * onto a transparent 2D context. Engine-agnostic: the map underneath is drawn
 * separately (MapLibre, canvas, …).
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  o: OverlayCtx,
  videoT: number,
  clear = true,
) {
  const { act, cfg, timeline } = o
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  // Stage draws onto a dedicated transparent canvas (clear each frame). The
  // exporter composites the overlay *on top of the map* in one canvas, so it
  // must NOT clear or it would erase the map (to black on an opaque context).
  if (clear) ctx.clearRect(0, 0, W, H)
  const margin = Math.round(Math.min(W, H) * 0.035)
  const base = H / 36
  const idx = timeline.indexAtVideoTime(videoT)
  const p = sampleAt(act, idx)
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

  if (cfg.widgets.includes('profile') && act.stats.hasEle) {
    const ph = Math.round(H * 0.12)
    drawProfile(ctx, o, margin, bottomY - ph, W - margin * 2, ph, idx, base)
    bottomY -= ph + margin * 0.6
  }

  const chips = cfg.widgets.filter((w) => w !== 'profile')
  if (chips.length) {
    const chipH = Math.round(base * 2.4)
    const gap = Math.round(margin * 0.4)
    let x = margin
    const y = bottomY - chipH
    for (const kind of chips) {
      const v = widgetValue(kind, live, act.stats, cfg.units)
      const valStr = v.unit ? `${v.value} ${v.unit}` : v.value
      ctx.font = `700 ${Math.round(base)}px system-ui, sans-serif`
      const valW = ctx.measureText(valStr).width
      ctx.font = `600 ${Math.round(base * 0.62)}px system-ui, sans-serif`
      const labW = ctx.measureText(v.label.toUpperCase()).width
      const cw = Math.max(valW, labW) + margin * 0.9
      if (x + cw > W - margin) break
      chip(ctx, x, y, cw, chipH, v.label.toUpperCase(), valStr, base)
      x += cw + gap
    }
  }

  if (cfg.showTitle && cfg.title) {
    const ts = Math.round(base * 1.3)
    ctx.font = `800 ${ts}px system-ui, sans-serif`
    const tw = ctx.measureText(cfg.title).width
    panel(ctx, margin, margin, tw + margin, ts + margin * 0.8)
    ctx.fillStyle = '#fff'
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    ctx.fillText(cfg.title, margin + margin * 0.5, margin + margin * 0.4)
    if (act.sport) {
      ctx.font = `600 ${Math.round(base * 0.7)}px system-ui, sans-serif`
      ctx.fillStyle = 'rgba(255,255,255,0.75)'
      ctx.fillText(act.sport, margin + margin * 0.5, margin + margin * 0.4 + ts + 2)
    }
  }

  // Attribution (MapLibre's own is hidden in export; bake ours in).
  ctx.font = `${Math.round(base * 0.5)}px system-ui, sans-serif`
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  const aw = ctx.measureText(o.attribution).width
  ctx.fillStyle = 'rgba(0,0,0,0.45)'
  ctx.fillRect(W - aw - 12, H - base * 0.9, aw + 12, base * 0.9)
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.fillText(o.attribution, W - 6, H - 4)
  ctx.textAlign = 'left'
}

function chip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: string,
  base: number,
) {
  panel(ctx, x, y, w, h)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.font = `600 ${Math.round(base * 0.62)}px system-ui, sans-serif`
  ctx.fillText(label, x + w * 0.12, y + h * 0.14)
  ctx.fillStyle = '#fff'
  ctx.font = `700 ${Math.round(base)}px system-ui, sans-serif`
  ctx.fillText(value, x + w * 0.12, y + h * 0.42)
}

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
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

function drawProfile(
  ctx: CanvasRenderingContext2D,
  o: OverlayCtx,
  x: number,
  y: number,
  w: number,
  h: number,
  idx: number,
  _base: number,
) {
  const { act, cfg, timeline } = o
  const d = act.derived
  const n = d.length
  const minE = act.stats.minEle ?? 0
  const maxE = act.stats.maxEle ?? 1
  const range = Math.max(1, maxE - minE)
  panel(ctx, x, y, w, h)
  const padX = w * 0.02
  const padY = h * 0.18
  const gx = x + padX
  const gw = w - padX * 2
  const gy = y + padY
  const gh = h - padY * 2
  const total = act.stats.totalDistance

  const eleAt = (i: number) => {
    const e = act.points[i].ele ?? minE
    return gy + gh - ((e - minE) / range) * gh
  }
  ctx.beginPath()
  ctx.moveTo(gx, gy + gh)
  for (let i = 0; i < n; i++) ctx.lineTo(gx + (d[i].dist / total) * gw, eleAt(i))
  ctx.lineTo(gx + gw, gy + gh)
  ctx.closePath()
  ctx.fillStyle = 'rgba(255,255,255,0.18)'
  ctx.fill()

  const headDist = sampleAt(act, idx).dist
  const headX = gx + (headDist / total) * gw
  ctx.save()
  ctx.beginPath()
  ctx.rect(gx, y, headX - gx, h)
  ctx.clip()
  ctx.beginPath()
  ctx.moveTo(gx, gy + gh)
  for (let i = 0; i < n; i++) ctx.lineTo(gx + (d[i].dist / total) * gw, eleAt(i))
  ctx.lineTo(gx + gw, gy + gh)
  ctx.closePath()
  ctx.fillStyle = cfg.accentColor
  ctx.globalAlpha = 0.55
  ctx.fill()
  ctx.restore()
  ctx.globalAlpha = 1

  ctx.beginPath()
  ctx.moveTo(headX, gy - 2)
  ctx.lineTo(headX, gy + gh + 2)
  ctx.strokeStyle = cfg.accentColor
  ctx.lineWidth = 2
  ctx.stroke()

  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  ctx.font = `600 ${Math.round(h * 0.16)}px system-ui, sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(`▲ ${Math.round(act.stats.totalGain)} m`, gx + 4, y + 4)
  ctx.textAlign = 'right'
  ctx.fillText(fmtDuration(timeline.realDuration), x + w - 4, y + 4)
  ctx.textAlign = 'left'
}
