import type { Activity, TimelineConfig } from './types'

/**
 * The video timeline. Maps a video time (seconds) onto a fractional index into
 * the activity's points, honouring either a speed multiplier or a target length.
 */
export class Timeline {
  constructor(
    private act: Activity,
    private cfg: TimelineConfig,
  ) {}

  /** Real activity duration in seconds (timestamped span, or point count). */
  get realDuration(): number {
    return this.act.derived[this.act.derived.length - 1].t
  }

  /** Final video duration in seconds. */
  get videoDuration(): number {
    if (this.cfg.mode === 'target') return Math.max(1, this.cfg.targetDuration)
    return Math.max(0.5, this.realDuration / this.cfg.speed)
  }

  /** Effective speed multiplier (real seconds per video second). */
  get effectiveSpeed(): number {
    if (this.cfg.mode === 'target') return this.realDuration / this.videoDuration
    return this.cfg.speed
  }

  /** Map a video time -> fractional point index via the time axis. */
  indexAtVideoTime(videoT: number): number {
    const realT = Math.min(this.realDuration, Math.max(0, videoT * this.effectiveSpeed))
    return this.indexAtRealTime(realT)
  }

  /** Binary-search the derived[].t axis for a real-time value -> fractional index. */
  private indexAtRealTime(realT: number): number {
    const d = this.act.derived
    let lo = 0
    let hi = d.length - 1
    if (realT <= d[0].t) return 0
    if (realT >= d[hi].t) return hi
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (d[mid].t <= realT) lo = mid
      else hi = mid
    }
    const span = d[hi].t - d[lo].t
    const f = span > 0 ? (realT - d[lo].t) / span : 0
    return lo + f
  }
}

// --- Exponential speed slider helpers (x1 .. x200) ---
export const SPEED_MIN = 1
export const SPEED_MAX = 200

/** Slider position [0..1] -> exponential speed multiplier. */
export function sliderToSpeed(pos: number): number {
  const v = SPEED_MIN * (SPEED_MAX / SPEED_MIN) ** pos
  return Math.round(v)
}

/** Speed multiplier -> slider position [0..1]. */
export function speedToSlider(speed: number): number {
  const s = Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed))
  return Math.log(s / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN)
}
