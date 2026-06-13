import type { Activity, ActivityStats, DerivedSample, TrackPoint } from './types'

const R = 6371008.8 // mean earth radius, m

export function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180
  const dLon = ((bLon - aLon) * Math.PI) / 180
  const la1 = (aLat * Math.PI) / 180
  const la2 = (bLat * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Build derived per-point metrics + aggregate stats from raw points. */
export function buildActivity(
  name: string,
  sport: string | null,
  points: TrackPoint[],
): Activity {
  if (points.length < 2) throw new Error('Track has too few points')

  const hasTime = points.every((p) => p.time != null) && points[0].time !== points[points.length - 1].time
  const startTime = points[0].time

  // Per-segment distance + raw speed.
  const n = points.length
  const segDist = new Float64Array(n)
  const cumDist = new Float64Array(n)
  const tSec = new Float64Array(n)
  const rawSpeed = new Float64Array(n)

  for (let i = 1; i < n; i++) {
    const d = haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon)
    segDist[i] = d
    cumDist[i] = cumDist[i - 1] + d
    if (hasTime) {
      tSec[i] = (points[i].time! - startTime!) / 1000
    } else {
      tSec[i] = i // synthetic 1s cadence
    }
    const dt = tSec[i] - tSec[i - 1]
    rawSpeed[i] = dt > 0 ? d / dt : 0
  }
  rawSpeed[0] = rawSpeed[1] ?? 0

  // Smooth speed with a short moving average to kill GPS jitter.
  const speed = movingAverage(rawSpeed, 5)

  // Elevation gain + grade.
  const gain = new Float64Array(n)
  const grade = new Float64Array(n)
  const eleSmooth = smoothEle(points)
  let totalGain = 0
  let totalLoss = 0
  for (let i = 1; i < n; i++) {
    const de = eleSmooth[i] - eleSmooth[i - 1]
    if (de > 0) totalGain += de
    else totalLoss += -de
    gain[i] = totalGain
    grade[i] = segDist[i] > 1 ? de / segDist[i] : grade[i - 1] ?? 0
  }
  grade[0] = grade[1] ?? 0

  // "De-paused" play axis: compress stopped stretches (and cap GPS-dropout gaps)
  // so the animation flows continuously, like the Strava flyby viewer.
  const MOVE_MS = 0.6 // m/s below which we consider the rider stopped
  const GAP_CAP = 6 // s: clamp long single-sample gaps (pause/auto-pause/dropout)
  const playT = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    const dt = tSec[i] - tSec[i - 1]
    const moving = speed[i] > MOVE_MS
    const dtPlay = moving ? Math.min(dt, GAP_CAP) : dt * 0.04
    playT[i] = playT[i - 1] + Math.max(dtPlay, 0)
  }

  const derived: DerivedSample[] = new Array(n)
  for (let i = 0; i < n; i++) {
    derived[i] = {
      dist: cumDist[i],
      speed: speed[i],
      gain: gain[i],
      grade: grade[i],
      t: tSec[i],
      playT: playT[i],
    }
  }

  const stats = aggregate(points, derived, tSec, hasTime, startTime, totalGain, totalLoss)
  const bbox = boundingBox(points)
  return { name, sport, points, derived, stats, bbox }
}

function movingAverage(arr: Float64Array, win: number): Float64Array {
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

function smoothEle(points: TrackPoint[]): Float64Array {
  const n = points.length
  const raw = new Float64Array(n)
  let last = 0
  for (let i = 0; i < n; i++) {
    last = points[i].ele ?? last
    raw[i] = last
  }
  return movingAverage(raw, 7)
}

function aggregate(
  points: TrackPoint[],
  derived: DerivedSample[],
  tSec: Float64Array,
  hasTime: boolean,
  startTime: number | null,
  totalGain: number,
  totalLoss: number,
): ActivityStats {
  const n = points.length
  let maxSpeed = 0
  let movingTime = 0
  let hrSum = 0
  let hrCnt = 0
  let maxHr: number | null = null
  let pwrSum = 0
  let pwrCnt = 0
  let maxPower: number | null = null
  let maxEle: number | null = null
  let minEle: number | null = null

  for (let i = 0; i < n; i++) {
    const s = derived[i].speed
    if (s > maxSpeed) maxSpeed = s
    if (i > 0 && s > 0.5) movingTime += tSec[i] - tSec[i - 1]
    const p = points[i]
    if (p.hr != null) {
      hrSum += p.hr
      hrCnt++
      maxHr = maxHr == null ? p.hr : Math.max(maxHr, p.hr)
    }
    if (p.power != null) {
      pwrSum += p.power
      pwrCnt++
      maxPower = maxPower == null ? p.power : Math.max(maxPower, p.power)
    }
    if (p.ele != null) {
      maxEle = maxEle == null ? p.ele : Math.max(maxEle, p.ele)
      minEle = minEle == null ? p.ele : Math.min(minEle, p.ele)
    }
  }

  const totalDistance = derived[n - 1].dist
  const duration = tSec[n - 1]
  return {
    totalDistance,
    totalGain,
    totalLoss,
    duration,
    movingTime: movingTime || duration,
    maxSpeed,
    avgSpeed: (movingTime || duration) > 0 ? totalDistance / (movingTime || duration) : 0,
    maxHr,
    avgHr: hrCnt ? hrSum / hrCnt : null,
    maxEle,
    minEle,
    maxPower,
    avgPower: pwrCnt ? pwrSum / pwrCnt : null,
    hasTime,
    hasHr: hrCnt > 0,
    hasEle: maxEle != null,
    hasCad: points.some((p) => p.cad != null),
    hasPower: pwrCnt > 0,
    hasTemp: points.some((p) => p.temp != null),
    startTime,
  }
}

function boundingBox(points: TrackPoint[]): [number, number, number, number] {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const p of points) {
    if (p.lon < w) w = p.lon
    if (p.lon > e) e = p.lon
    if (p.lat < s) s = p.lat
    if (p.lat > n) n = p.lat
  }
  return [w, s, e, n]
}

/** Interpolate point + derived metrics at a fractional index (for smooth animation). */
export function sampleAt(act: Activity, idx: number) {
  const n = act.points.length
  const i0 = Math.max(0, Math.min(n - 1, Math.floor(idx)))
  const i1 = Math.min(n - 1, i0 + 1)
  const f = idx - i0
  const a = act.points[i0]
  const b = act.points[i1]
  const da = act.derived[i0]
  const db = act.derived[i1]
  const lerp = (x: number, y: number) => x + (y - x) * f
  const lerpN = (x: number | null, y: number | null) =>
    x == null ? y : y == null ? x : lerp(x, y)
  return {
    lat: lerp(a.lat, b.lat),
    lon: lerp(a.lon, b.lon),
    ele: lerpN(a.ele, b.ele),
    hr: lerpN(a.hr, b.hr),
    cad: lerpN(a.cad, b.cad),
    power: lerpN(a.power, b.power),
    temp: lerpN(a.temp, b.temp),
    speed: lerp(da.speed, db.speed),
    dist: lerp(da.dist, db.dist),
    gain: lerp(da.gain, db.gain),
    grade: lerp(da.grade, db.grade),
    t: lerp(da.t, db.t),
  }
}
