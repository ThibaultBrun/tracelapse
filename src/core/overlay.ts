import type { Activity, ActivityStats, RenderConfig } from './types'
import type { Timeline } from './timeline'
import { sampleAt } from './metrics'
import { fmtDuration, summaryItems, widgetValue, type LiveSample } from './widgets'

export interface OverlayCtx {
  act: Activity
  cfg: RenderConfig
  timeline: Timeline
  attribution: string
  /** Pista trail the rider is currently on (evaluated per frame). */
  currentTrail?: () => { name: string; difficulty: string | null } | null
}

const DIFF_COLOR: Record<string, string> = {
  green: '#3aa14a', blue: '#2b7fff', red: '#e23b3b', black: '#111111',
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

  // Intro: title + summary card over the fly-in; widgets stay hidden.
  const introDur = cfg.showIntro ? Math.max(0, cfg.introDuration) : 0
  if (videoT < introDur) {
    drawIntroCard(ctx, o, videoT / introDur, base, margin)
    drawCredit(ctx, base)
    return
  }

  // Outro: pull back to the whole route with summary + big site address.
  const outroDur = cfg.showOutro ? Math.max(0, cfg.outroDuration) : 0
  const afterIntro = videoT - introDur
  if (outroDur > 0 && afterIntro > timeline.videoDuration) {
    drawOutroCard(ctx, o, Math.min(1, (afterIntro - timeline.videoDuration) / outroDur), base, margin)
    drawCredit(ctx, base)
    return
  }

  const idx = timeline.indexAtVideoTime(afterIntro)
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
    // Size each chip to its widest possible value (from the activity's maxima),
    // so chips never resize/jump as the digit count changes mid-animation.
    const peak = peakSample(act.stats, timeline.realDuration)
    const valFont = `700 ${Math.round(base)}px Inter, system-ui, sans-serif`
    const labFont = `600 ${Math.round(base * 0.62)}px Inter, system-ui, sans-serif`
    const padX = base * 0.55
    const unitGap = base * 0.22
    for (const kind of chips) {
      const v = widgetValue(kind, live, act.stats, cfg.units)
      const pv = widgetValue(kind, peak, act.stats, cfg.units)
      // Fixed-width numeric column (≥3 integer digits) so the number grows
      // leftward and the unit never drifts.
      const dot = v.value.indexOf('.')
      const dec = dot >= 0 ? v.value.length - dot - 1 : 0
      const peakInt = pv.value.split('.')[0].replace('-', '').length
      const numTpl = '8'.repeat(Math.max(3, peakInt)) + (dec > 0 ? '.' + '8'.repeat(dec) : '')
      ctx.font = valFont
      const numColW = ctx.measureText(numTpl).width
      const unitW = v.unit ? ctx.measureText(' ' + v.unit).width : 0
      ctx.font = labFont
      const labW = ctx.measureText(v.label.toUpperCase()).width
      const cw = Math.max(numColW + (v.unit ? unitGap + unitW : 0), labW) + padX * 2
      if (x + cw > W - margin) break
      chipFixed(ctx, x, y, cw, chipH, v.label.toUpperCase(), v.value, v.unit, numColW, padX, unitGap, base)
      x += cw + gap
    }
  }

  if (cfg.showTitle && cfg.title) {
    const ts = Math.round(base * 1.3)
    ctx.font = `800 ${ts}px Inter, system-ui, sans-serif`
    const tw = ctx.measureText(cfg.title).width
    panel(ctx, margin, margin, tw + margin, ts + margin * 0.8)
    ctx.fillStyle = '#fff'
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    ctx.fillText(cfg.title, margin + margin * 0.5, margin + margin * 0.4)
    if (act.sport) {
      ctx.font = `600 ${Math.round(base * 0.7)}px Inter, system-ui, sans-serif`
      ctx.fillStyle = 'rgba(255,255,255,0.75)'
      ctx.fillText(act.sport, margin + margin * 0.5, margin + margin * 0.4 + ts + 2)
    }
  }

  drawTopSpeed(ctx, o, idx, base)
  drawTrailName(ctx, o, base)

  // Attribution (MapLibre's own is hidden in export; bake ours in).
  ctx.font = `${Math.round(base * 0.5)}px Inter, system-ui, sans-serif`
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  const aw = ctx.measureText(o.attribution).width
  ctx.fillStyle = 'rgba(0,0,0,0.45)'
  ctx.fillRect(W - aw - 12, H - base * 0.9, aw + 12, base * 0.9)
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.fillText(o.attribution, W - 6, H - 4)
  ctx.textAlign = 'left'

  drawCredit(ctx, base)
}

/** A LiveSample carrying each metric's widest value, for stable chip sizing. */
function peakSample(s: ActivityStats, realDuration: number): LiveSample {
  return {
    speed: s.maxSpeed,
    dist: s.totalDistance,
    ele: s.maxEle ?? 0,
    gain: Math.max(s.totalGain, s.totalLoss),
    grade: -0.999,
    hr: s.maxHr ?? 199,
    cad: 199,
    power: s.maxPower ?? 999,
    temp: -19,
    t: realDuration,
  }
}

/** Pill naming the Pista trail the rider is on, top-centre. */
function drawTrailName(ctx: CanvasRenderingContext2D, o: OverlayCtx, base: number) {
  const trail = o.currentTrail?.()
  if (!trail) return
  const W = ctx.canvas.width
  const cx = W / 2
  const y = ctx.canvas.height * 0.085
  const color = (trail.difficulty && DIFF_COLOR[trail.difficulty]) || o.cfg.accentColor
  const label = trail.name
  ctx.save()
  ctx.font = `800 ${Math.round(base * 0.85)}px Inter, system-ui, sans-serif`
  const tw = ctx.measureText(label).width
  const padX = base * 0.9
  const dotR = base * 0.42
  const h = base * 1.8
  const w = tw + padX * 2 + dotR * 2 + base * 0.5
  const x = cx - w / 2
  // Pill.
  const r = h / 2
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
  ctx.fillStyle = 'rgba(20,17,12,0.78)'
  ctx.shadowColor = 'rgba(0,0,0,0.5)'
  ctx.shadowBlur = base * 0.4
  ctx.fill()
  ctx.shadowBlur = 0
  // Difficulty dot.
  ctx.beginPath()
  ctx.arc(x + padX + dotR, y + h / 2, dotR, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  // Name.
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + padX + dotR * 2 + base * 0.5, y + h / 2 + base * 0.04)
  ctx.restore()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

/** Flash a "TOP SPEED" badge as the rider reaches the activity's peak speed. */
function drawTopSpeed(ctx: CanvasRenderingContext2D, o: OverlayCtx, idx: number, base: number) {
  const { act, cfg } = o
  const n = act.points.length
  const win = Math.max(2, Math.round(n * 0.012))
  const dist = Math.abs(idx - act.stats.maxSpeedIdx)
  if (dist > win) return
  const a = 1 - dist / win // 1 at the peak, fades out around it
  const W = ctx.canvas.width
  const cx = W / 2
  const cy = ctx.canvas.height * 0.2
  const v = (cfg.units === 'imperial' ? act.stats.maxSpeed * 2.23694 : act.stats.maxSpeed * 3.6).toFixed(1)
  const unit = cfg.units === 'imperial' ? 'mph' : 'km/h'

  ctx.save()
  ctx.globalAlpha = a
  ctx.translate(cx, cy)
  ctx.scale(0.9 + 0.1 * a, 0.9 + 0.1 * a)
  ctx.textAlign = 'center'
  const labelF = Math.round(base * 0.72)
  const valF = Math.round(base * 1.7)
  ctx.font = `800 ${valF}px Inter, system-ui, sans-serif`
  const valStr = `${v} ${unit}`
  const wPill = Math.max(ctx.measureText(valStr).width, base * 6) + base * 2.4
  const hPill = valF + labelF + base * 1.3
  // Gold pill.
  const r = hPill * 0.28
  const x = -wPill / 2
  const y = -hPill / 2
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + wPill, y, x + wPill, y + hPill, r)
  ctx.arcTo(x + wPill, y + hPill, x, y + hPill, r)
  ctx.arcTo(x, y + hPill, x, y, r)
  ctx.arcTo(x, y, x + wPill, y, r)
  ctx.closePath()
  ctx.shadowColor = cfg.accentColor
  ctx.shadowBlur = base * 1.2
  ctx.fillStyle = cfg.accentColor
  ctx.fill()
  ctx.shadowBlur = 0
  // Text.
  ctx.fillStyle = 'rgba(20,17,12,0.92)'
  ctx.font = `800 ${labelF}px Inter, system-ui, sans-serif`
  ctx.textBaseline = 'top'
  ctx.fillText('🔥 TOP SPEED', 0, y + base * 0.45)
  ctx.fillStyle = '#1c1812'
  ctx.font = `800 ${valF}px Inter, system-ui, sans-serif`
  ctx.fillText(valStr, 0, y + base * 0.45 + labelF)
  ctx.restore()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

export const SITE_URL = 'tracelapse.pista.bike'

/** Site copyright/watermark, bottom-left of every frame. */
function drawCredit(ctx: CanvasRenderingContext2D, base: number) {
  const H = ctx.canvas.height
  const fs = Math.round(base * 0.6)
  ctx.font = `700 ${fs}px Inter, system-ui, sans-serif`
  const label = `© ${SITE_URL}`
  const w = ctx.measureText(label).width
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  ctx.fillStyle = 'rgba(0,0,0,0.4)'
  ctx.fillRect(0, H - fs * 1.7, w + fs * 1.2, fs * 1.7)
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  ctx.fillText(label, fs * 0.6, H - fs * 0.5)
}

/** Intro title + summary card, fading in/out across the fly-in. */
function drawIntroCard(ctx: CanvasRenderingContext2D, o: OverlayCtx, p: number, base: number, margin: number) {
  const { cfg } = o
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  // Fade in over first 18%, hold, fade out over last 28%.
  const a = p < 0.18 ? p / 0.18 : p > 0.72 ? Math.max(0, 1 - (p - 0.72) / 0.28) : 1
  ctx.save()
  ctx.globalAlpha = a
  // Legibility scrim.
  const grad = ctx.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0, 'rgba(20,17,12,0.6)')
  grad.addColorStop(0.5, 'rgba(20,17,12,0.12)')
  grad.addColorStop(1, 'rgba(20,17,12,0.6)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, H)

  const cx = W / 2
  const cy = H * 0.42
  ctx.textAlign = 'center'
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = base * 0.5
  // Title.
  const ts = Math.round(base * 2.1)
  ctx.font = `800 ${ts}px Inter, system-ui, sans-serif`
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'bottom'
  wrapText(ctx, cfg.title || '', cx, cy, W - margin * 4, ts * 1.1)
  // Accent rule.
  ctx.shadowBlur = 0
  ctx.fillStyle = cfg.accentColor
  ctx.fillRect(cx - base * 1.6, cy + base * 0.5, base * 3.2, Math.max(2, base * 0.12))
  // Summary stat grid.
  drawSummaryGrid(ctx, o, cx, cy + base * 1.4, base)
  ctx.restore()
  ctx.textAlign = 'left'
  ctx.shadowBlur = 0
}

/** Lay out the chosen summary stats as a centered grid (2 columns): big value + small label. */
function drawSummaryGrid(ctx: CanvasRenderingContext2D, o: OverlayCtx, cx: number, top: number, base: number) {
  const items = summaryItems(o.cfg.summaryStats, o.act.stats, o.cfg.units)
  if (!items.length) return
  const cols = items.length <= 3 ? 1 : 2
  const colW = base * 7
  const rowH = base * 2.1
  ctx.shadowBlur = base * 0.35
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  for (let i = 0; i < items.length; i++) {
    const col = cols === 1 ? 0 : i % cols
    const row = cols === 1 ? i : Math.floor(i / cols)
    const x = cx + (cols === 1 ? 0 : (col === 0 ? -colW / 2 : colW / 2))
    const y = top + row * rowH
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = '#fff'
    ctx.font = `800 ${Math.round(base * 1.05)}px Inter, system-ui, sans-serif`
    ctx.fillText(items[i].value, x, y)
    ctx.fillStyle = o.cfg.accentColor
    ctx.font = `700 ${Math.round(base * 0.55)}px Inter, system-ui, sans-serif`
    ctx.fillText(items[i].label.toUpperCase(), x, y + base * 1.15)
  }
  ctx.shadowBlur = 0
}

/** Outro card: summary + big site address as the camera pulls back. */
function drawOutroCard(ctx: CanvasRenderingContext2D, o: OverlayCtx, p: number, base: number, margin: number) {
  const { cfg } = o
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  const a = p < 0.22 ? p / 0.22 : 1 // fade in, then hold to the end
  ctx.save()
  ctx.globalAlpha = a
  const grad = ctx.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0, 'rgba(20,17,12,0.62)')
  grad.addColorStop(0.5, 'rgba(20,17,12,0.18)')
  grad.addColorStop(1, 'rgba(20,17,12,0.68)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, H)

  const cx = W / 2
  const cy = H * 0.4
  ctx.textAlign = 'center'
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = base * 0.5

  if (cfg.title) {
    ctx.font = `800 ${Math.round(base * 1.5)}px Inter, system-ui, sans-serif`
    ctx.fillStyle = '#fff'
    ctx.textBaseline = 'bottom'
    wrapText(ctx, cfg.title, cx, cy - base * 0.3, W - margin * 4, base * 1.6)
  }
  // Summary stat grid.
  drawSummaryGrid(ctx, o, cx, cy, base)
  const items = summaryItems(cfg.summaryStats, o.act.stats, cfg.units)
  const gridRows = Math.ceil(items.length / (items.length <= 3 ? 1 : 2))
  const urlY = cy + gridRows * base * 2.1 + base * 0.8
  // Big site address.
  ctx.shadowBlur = 0
  ctx.fillStyle = cfg.accentColor
  ctx.fillRect(cx - base * 2, urlY, base * 4, Math.max(2, base * 0.12))
  ctx.shadowColor = cfg.accentColor
  ctx.shadowBlur = base * 1.2
  ctx.fillStyle = '#fff'
  ctx.font = `800 ${Math.round(base * 1.7)}px Inter, system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(SITE_URL, cx, urlY + base * 0.5)
  ctx.restore()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.shadowBlur = 0
}

/** Draw possibly-multiline centered text, growing upward from y (baseline bottom). */
function wrapText(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, maxW: number, lineH: number) {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const test = line ? `${line} ${w}` : w
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line)
      line = w
    } else line = test
  }
  if (line) lines.push(line)
  const startY = y - (lines.length - 1) * lineH
  lines.forEach((l, i) => ctx.fillText(l, cx, startY + i * lineH))
}

function chipFixed(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  num: string,
  unit: string,
  numColW: number,
  padX: number,
  unitGap: number,
  base: number,
) {
  panel(ctx, x, y, w, h)
  // Label (left-aligned, top).
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.font = `600 ${Math.round(base * 0.62)}px Inter, system-ui, sans-serif`
  ctx.fillText(label, x + padX, y + h * 0.14)
  // Number right-aligned within its fixed column, unit pinned just after it.
  ctx.font = `700 ${Math.round(base)}px Inter, system-ui, sans-serif`
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'right'
  ctx.fillText(num, x + padX + numColW, y + h * 0.42)
  if (unit) {
    ctx.textAlign = 'left'
    ctx.fillStyle = 'rgba(255,255,255,0.82)'
    ctx.fillText(unit, x + padX + numColW + unitGap, y + h * 0.42)
  }
  ctx.textAlign = 'left'
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
  ctx.fillStyle = 'rgba(37,33,26,0.66)'
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
  ctx.font = `600 ${Math.round(h * 0.16)}px Inter, system-ui, sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(`▲ ${Math.round(act.stats.totalGain)} m`, gx + 4, y + 4)
  ctx.textAlign = 'right'
  ctx.fillText(fmtDuration(timeline.realDuration), x + w - 4, y + 4)
  ctx.textAlign = 'left'
}
