import { reactive } from 'vue'
import type { Activity, RenderConfig, TimelineConfig, WidgetKind } from './core/types'
import { parseTrack } from './core/gpx'
import { buildActivity } from './core/metrics'

export interface ResolutionPreset {
  label: string
  width: number
  height: number
}

export const RESOLUTIONS: ResolutionPreset[] = [
  { label: 'Reels / TikTok 9:16', width: 1080, height: 1920 },
  { label: 'YouTube 16:9', width: 1920, height: 1080 },
  { label: 'Square 1:1', width: 1080, height: 1080 },
  { label: 'Light 9:16 (720)', width: 720, height: 1280 },
]

export interface WidgetPreset {
  label: string
  widgets: WidgetKind[]
}

export const WIDGET_PRESETS: WidgetPreset[] = [
  { label: 'Minimal', widgets: ['speed', 'distance', 'time'] },
  { label: 'Performance', widgets: ['speed', 'hr', 'power', 'cadence', 'time'] },
  { label: 'Mountain', widgets: ['speed', 'distance', 'gain', 'grade', 'profile'] },
  { label: 'Full', widgets: ['speed', 'distance', 'elevation', 'gain', 'hr', 'time', 'profile'] },
]

interface State {
  activity: Activity | null
  loading: boolean
  error: string | null
  render: RenderConfig
  timeline: TimelineConfig
}

export const state = reactive<State>({
  activity: null,
  loading: false,
  error: null,
  render: {
    width: 1080,
    height: 1920,
    fps: 30,
    mapStyleId: 'sat',
    camera: 'follow',
    followZoom: 15.5,
    fitPadding: 0.18,
    trackColor: '#ffffff',
    accentColor: '#fc5200',
    trackWidth: 6,
    markerSize: 9,
    showFullRoute: true,
    widgets: ['speed', 'distance', 'gain', 'profile'],
    title: '',
    showTitle: true,
    units: 'metric',
    terrain3d: true,
    pitch: 62,
    terrainExaggeration: 1.4,
    rotateWithHeading: false,
    markerIcon: 'dot',
    showIntro: true,
    introDuration: 2.6,
    summary: '',
  },
  timeline: {
    mode: 'speed',
    speed: 20,
    targetDuration: 20,
  },
})

/** Parse GPX/TCX text into an activity and load it as the current scene. */
export function loadGpxText(text: string, fileName: string) {
  const parsed = parseTrack(text, fileName)
  if (parsed.points.length < 2) throw new Error('No GPS points found in file')
  const act = buildActivity(parsed.name, parsed.sport, parsed.points)
  state.activity = act
  state.render.title = act.name
  state.render.summary = buildSummary(act)
  // Auto-pick sensible widgets based on what the activity carries.
  state.render.widgets = autoWidgets(act)
  // Default to a target duration that feels good.
  state.timeline.mode = 'target'
  state.timeline.targetDuration = act.stats.duration > 0 ? 25 : 15
}

export async function loadFiles(files: FileList | File[]) {
  const list = Array.from(files)
  if (!list.length) return
  state.loading = true
  state.error = null
  try {
    const file = list[0] // first track file (multi-track merge could come later)
    loadGpxText(await file.text(), file.name)
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e)
    state.activity = null
  } finally {
    state.loading = false
  }
}

/** Load the bundled demo ride so visitors can try the app with no file. */
export async function loadDemo() {
  state.loading = true
  state.error = null
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}sample.gpx`)
    const text = await res.text()
    const file = new File([text], 'demo-ibardin.gpx', { type: 'application/gpx+xml' })
    await loadFiles([file])
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e)
  } finally {
    state.loading = false
  }
}

function buildSummary(act: Activity): string {
  const s = act.stats
  const parts = [`${(s.totalDistance / 1000).toFixed(1)} km`]
  if (s.hasEle) parts.push(`${Math.round(s.totalGain)} m D+`)
  if (s.hasTime) parts.push(`${Math.round(s.movingTime / 60)} min`)
  if (s.startTime) {
    const d = new Date(s.startTime)
    parts.push(d.toLocaleDateString())
  }
  return parts.join('  ·  ')
}

function autoWidgets(act: Activity): WidgetKind[] {
  const w: WidgetKind[] = ['speed', 'distance']
  if (act.stats.hasEle) w.push('gain')
  if (act.stats.hasHr) w.push('hr')
  if (act.stats.hasTime) w.push('time')
  if (act.stats.hasEle) w.push('profile')
  return w
}
