// Core domain types for Tracelapse.

/** A single GPS sample from a track. */
export interface TrackPoint {
  lat: number
  lon: number
  /** Elevation in metres (null if absent). */
  ele: number | null
  /** Epoch milliseconds (null if the track has no timestamps). */
  time: number | null
  /** Heart rate in bpm. */
  hr: number | null
  /** Cadence (rpm / spm). */
  cad: number | null
  /** Power in watts. */
  power: number | null
  /** Air/water temperature in °C. */
  temp: number | null
}

/** Per-point derived metrics, index-aligned with TrackPoint[]. */
export interface DerivedSample {
  /** Cumulative distance from start, metres. */
  dist: number
  /** Instantaneous speed, m/s (smoothed). */
  speed: number
  /** Cumulative elevation gain, metres. */
  gain: number
  /** Slope/grade as a ratio (0.08 = 8%). */
  grade: number
  /** Seconds elapsed since start (uses timestamps, falls back to index). */
  t: number
  /** "De-paused" time axis: stopped stretches compressed so playback flows. */
  playT: number
}

export interface ActivityStats {
  totalDistance: number // m
  totalGain: number // m
  totalLoss: number // m
  duration: number // s (timestamp span)
  movingTime: number // s
  maxSpeed: number // m/s
  maxSpeedIdx: number // point index of peak speed
  avgSpeed: number // m/s
  maxHr: number | null
  avgHr: number | null
  maxEle: number | null
  minEle: number | null
  maxPower: number | null
  avgPower: number | null
  hasTime: boolean
  hasHr: boolean
  hasEle: boolean
  hasCad: boolean
  hasPower: boolean
  hasTemp: boolean
  startTime: number | null
}

export interface Activity {
  name: string
  sport: string | null
  points: TrackPoint[]
  derived: DerivedSample[]
  stats: ActivityStats
  /** Bounding box [west, south, east, north]. */
  bbox: [number, number, number, number]
}

export type WidgetKind =
  | 'speed'
  | 'pace'
  | 'distance'
  | 'elevation'
  | 'gain'
  | 'grade'
  | 'hr'
  | 'cadence'
  | 'power'
  | 'temp'
  | 'time'
  | 'clock'
  | 'profile' // mini elevation profile graph

export type CameraMode = 'fit' | 'follow'

export type DurationMode = 'speed' | 'target'

export interface MapStyleDef {
  id: string
  label: string
  /** URL template with {x}{y}{z}. */
  url: string
  attribution: string
  /** Dark basemap => use light track/UI colours. */
  dark: boolean
  maxZoom: number
}

export interface RenderConfig {
  width: number
  height: number
  fps: number
  mapStyleId: string
  camera: CameraMode
  /** Zoom level when camera = follow. */
  followZoom: number
  /** Padding ratio around the route when camera = fit. */
  fitPadding: number
  trackColor: string
  accentColor: string
  trackWidth: number
  markerSize: number
  showFullRoute: boolean
  widgets: WidgetKind[]
  title: string
  showTitle: boolean
  units: 'metric' | 'imperial'
  /** 3D terrain (tilted camera + DEM relief). */
  terrain3d: boolean
  /** Camera pitch in degrees when terrain3d is on. */
  pitch: number
  /** DEM vertical exaggeration. */
  terrainExaggeration: number
  /** Follow camera rotates to face the travel direction (off = steady north-up). */
  rotateWithHeading: boolean
  /** Marker: 'dot' or an emoji (rendered as a map image so it's captured). */
  markerIcon: string
  /** Intro fly-in (zoom from far above to the start) with a title card. */
  showIntro: boolean
  /** Intro duration in seconds. */
  introDuration: number
  /** Outro: zoom back out to frame the whole route, with summary + site address. */
  showOutro: boolean
  /** Outro duration in seconds. */
  outroDuration: number
  /** One-line summary shown under the title in the intro/outro. */
  summary: string
}

export interface TimelineConfig {
  mode: DurationMode
  /** Playback speed multiplier (real seconds compressed into 1 video second). */
  speed: number
  /** Target video length in seconds (when mode = 'target'). */
  targetDuration: number
  /**
   * Pacing 0..1: 0 = follow distance (constant spatial speed, very smooth),
   * 1 = follow real speed (fast where you rode fast). Blends the two.
   */
  pacing: number
}
