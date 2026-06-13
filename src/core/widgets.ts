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
