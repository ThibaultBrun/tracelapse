import type { ActivityStats, WidgetKind } from './types'

export interface WidgetMeta {
  kind: WidgetKind
  label: string
  /** Whether the activity actually carries the data for this widget. */
  available: (s: ActivityStats) => boolean
  icon: string
}

export const WIDGET_CATALOG: WidgetMeta[] = [
  { kind: 'speed', label: 'Speed', icon: '🚀', available: () => true },
  { kind: 'pace', label: 'Pace', icon: '⏱️', available: (s) => s.hasTime },
  { kind: 'distance', label: 'Distance', icon: '📏', available: () => true },
  { kind: 'elevation', label: 'Elevation', icon: '⛰️', available: (s) => s.hasEle },
  { kind: 'gain', label: 'Elev. gain', icon: '📈', available: (s) => s.hasEle },
  { kind: 'grade', label: 'Grade', icon: '📐', available: (s) => s.hasEle },
  { kind: 'hr', label: 'Heart rate', icon: '❤️', available: (s) => s.hasHr },
  { kind: 'cadence', label: 'Cadence', icon: '🔄', available: (s) => s.hasCad },
  { kind: 'power', label: 'Power', icon: '⚡', available: (s) => s.hasPower },
  { kind: 'temp', label: 'Temperature', icon: '🌡️', available: (s) => s.hasTemp },
  { kind: 'time', label: 'Elapsed', icon: '🕒', available: (s) => s.hasTime },
  { kind: 'clock', label: 'Time of day', icon: '🕓', available: (s) => s.startTime != null },
  { kind: 'profile', label: 'Elev. profile', icon: '🗻', available: (s) => s.hasEle },
]

export interface LiveSample {
  speed: number
  dist: number
  ele: number | null
  gain: number
  grade: number
  hr: number | null
  cad: number | null
  power: number | null
  temp: number | null
  t: number
}

type Units = 'metric' | 'imperial'

export interface WidgetValue {
  label: string
  value: string
  unit: string
}

export function widgetValue(
  kind: WidgetKind,
  s: LiveSample,
  stats: ActivityStats,
  units: Units,
): WidgetValue {
  const imp = units === 'imperial'
  switch (kind) {
    case 'speed': {
      const v = imp ? s.speed * 2.23694 : s.speed * 3.6
      return { label: 'Speed', value: v.toFixed(1), unit: imp ? 'mph' : 'km/h' }
    }
    case 'pace': {
      // min per km / mile
      const perKm = s.speed > 0.2 ? 1000 / s.speed : 0
      const per = imp ? perKm * 1.60934 : perKm
      return { label: 'Pace', value: fmtPace(per), unit: imp ? '/mi' : '/km' }
    }
    case 'distance': {
      const v = imp ? s.dist / 1609.34 : s.dist / 1000
      return { label: 'Distance', value: v.toFixed(2), unit: imp ? 'mi' : 'km' }
    }
    case 'elevation': {
      const e = s.ele ?? 0
      const v = imp ? e * 3.28084 : e
      return { label: 'Elevation', value: Math.round(v).toString(), unit: imp ? 'ft' : 'm' }
    }
    case 'gain': {
      const v = imp ? s.gain * 3.28084 : s.gain
      return { label: 'Elev. gain', value: Math.round(v).toString(), unit: imp ? 'ft' : 'm' }
    }
    case 'grade':
      return { label: 'Grade', value: (s.grade * 100).toFixed(1), unit: '%' }
    case 'hr':
      return { label: 'Heart rate', value: s.hr != null ? Math.round(s.hr).toString() : '–', unit: 'bpm' }
    case 'cadence':
      return { label: 'Cadence', value: s.cad != null ? Math.round(s.cad).toString() : '–', unit: 'rpm' }
    case 'power':
      return { label: 'Power', value: s.power != null ? Math.round(s.power).toString() : '–', unit: 'W' }
    case 'temp':
      return { label: 'Temp', value: s.temp != null ? Math.round(s.temp).toString() : '–', unit: '°C' }
    case 'time':
      return { label: 'Elapsed', value: fmtDuration(s.t), unit: '' }
    case 'clock': {
      if (stats.startTime == null) return { label: 'Time', value: '–', unit: '' }
      const d = new Date(stats.startTime + s.t * 1000)
      return {
        label: 'Time',
        value: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
        unit: '',
      }
    }
    case 'profile':
      return { label: 'Profile', value: '', unit: '' }
  }
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`
}

function fmtPace(secPerUnit: number): string {
  if (!Number.isFinite(secPerUnit) || secPerUnit <= 0 || secPerUnit > 3600) return '–'
  const m = Math.floor(secPerUnit / 60)
  const s = Math.round(secPerUnit % 60)
  return `${m}:${pad(s)}`
}

// --- Summary stats (intro/outro cards) ---
export type SummaryKey =
  | 'distance' | 'duration' | 'moving' | 'avgSpeed' | 'maxSpeed' | 'pace'
  | 'avgHr' | 'maxHr' | 'avgPower' | 'maxPower' | 'gain' | 'loss' | 'maxEle' | 'date'

export interface SummaryMeta {
  key: SummaryKey
  label: string
  available: (s: ActivityStats) => boolean
  value: (s: ActivityStats, units: 'metric' | 'imperial') => string
}

export const SUMMARY_CATALOG: SummaryMeta[] = [
  { key: 'distance', label: 'Distance', available: () => true,
    value: (s, u) => u === 'imperial' ? `${(s.totalDistance / 1609.34).toFixed(1)} mi` : `${(s.totalDistance / 1000).toFixed(1)} km` },
  { key: 'duration', label: 'Total time', available: (s) => s.hasTime, value: (s) => fmtDuration(s.duration) },
  { key: 'moving', label: 'Moving time', available: (s) => s.hasTime, value: (s) => fmtDuration(s.movingTime) },
  { key: 'avgSpeed', label: 'Avg speed', available: () => true,
    value: (s, u) => u === 'imperial' ? `${(s.avgSpeed * 2.23694).toFixed(1)} mph` : `${(s.avgSpeed * 3.6).toFixed(1)} km/h` },
  { key: 'maxSpeed', label: 'Max speed', available: () => true,
    value: (s, u) => u === 'imperial' ? `${(s.maxSpeed * 2.23694).toFixed(1)} mph` : `${(s.maxSpeed * 3.6).toFixed(1)} km/h` },
  { key: 'pace', label: 'Avg pace', available: (s) => s.hasTime,
    value: (s, u) => `${fmtPace(s.avgSpeed > 0.2 ? (u === 'imperial' ? 1609.34 : 1000) / s.avgSpeed : 0)} ${u === 'imperial' ? '/mi' : '/km'}` },
  { key: 'avgHr', label: 'Avg HR', available: (s) => s.hasHr, value: (s) => `${Math.round(s.avgHr!)} bpm` },
  { key: 'maxHr', label: 'Max HR', available: (s) => s.hasHr, value: (s) => `${Math.round(s.maxHr!)} bpm` },
  { key: 'avgPower', label: 'Avg power', available: (s) => s.hasPower, value: (s) => `${Math.round(s.avgPower!)} W` },
  { key: 'maxPower', label: 'Max power', available: (s) => s.hasPower, value: (s) => `${Math.round(s.maxPower!)} W` },
  { key: 'gain', label: 'Elev. gain', available: (s) => s.hasEle,
    value: (s, u) => u === 'imperial' ? `${Math.round(s.totalGain * 3.28084)} ft` : `${Math.round(s.totalGain)} m` },
  { key: 'loss', label: 'Elev. loss', available: (s) => s.hasEle,
    value: (s, u) => u === 'imperial' ? `${Math.round(s.totalLoss * 3.28084)} ft` : `${Math.round(s.totalLoss)} m` },
  { key: 'maxEle', label: 'Max alt.', available: (s) => s.hasEle,
    value: (s, u) => s.maxEle == null ? '–' : (u === 'imperial' ? `${Math.round(s.maxEle * 3.28084)} ft` : `${Math.round(s.maxEle)} m`) },
  { key: 'date', label: 'Date', available: (s) => s.startTime != null,
    value: (s) => (s.startTime ? new Date(s.startTime).toLocaleDateString() : '–') },
]

export function summaryItems(keys: string[], stats: ActivityStats, units: 'metric' | 'imperial'): { label: string; value: string }[] {
  return keys
    .map((k) => SUMMARY_CATALOG.find((m) => m.key === k))
    .filter((m): m is SummaryMeta => !!m && m.available(stats))
    .map((m) => ({ label: m.label, value: m.value(stats, units) }))
}
