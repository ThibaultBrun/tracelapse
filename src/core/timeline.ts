import type { Activity, RenderConfig, TimelineConfig } from './types'

/**
 * The video timeline. Maps a video time (seconds) onto a fractional index into
 * the activity's points, honouring either a speed multiplier or a target length.
 */
export class Timeline {
  /** Monotonic 0→1 progress axis blending distance and de-paused time. */
  private progress: Float64Array

  constructor(
    private act: Activity,
    private cfg: TimelineConfig,
  ) {
    const d = act.derived
    const n = d.length
    const distTot = d[n - 1].dist || 1
    const playTot = d[n - 1].playT || 1
    const w = Math.min(1, Math.max(0, cfg.pacing))
    this.progress = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      this.progress[i] = (1 - w) * (d[i].dist / distTot) + w * (d[i].playT / playTot)
    }
  }

  /** Real activity duration in seconds (timestamped span, or point count). */
  get realDuration(): number {
    return this.act.derived[this.act.derived.length - 1].t
  }

  /** "De-paused" duration that actually drives playback (stops compressed). */
  get playDuration(): number {
    return this.act.derived[this.act.derived.length - 1].playT
  }

  /** Final video duration in seconds. */
  get videoDuration(): number {
    if (this.cfg.mode === 'target') return Math.max(1, this.cfg.targetDuration)
    // Speed multiplier applies to the de-paused timeline so x20 always flows.
    return Math.max(0.5, this.playDuration / this.cfg.speed)
  }

  /** Effective speed multiplier vs *real* elapsed time (for the "Nx" label). */
  get effectiveSpeed(): number {
    return this.realDuration / this.videoDuration
  }

  /**
   * Map a video time -> fractional point index along the blended progress axis.
   * Pacing toward "distance" gives a constant spatial speed (smooth: fast and
   * slow sections play at the same visual pace); toward "speed" follows the real
   * pace. Pauses occupy ~no progress either way, so they're always skipped.
   */
  indexAtVideoTime(videoT: number): number {
    const target = Math.min(1, Math.max(0, videoT / this.videoDuration))
    const p = this.progress
    let lo = 0
    let hi = p.length - 1
    if (target <= p[0]) return 0
    if (target >= p[hi]) return hi
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (p[mid] <= target) lo = mid
      else hi = mid
    }
    const span = p[hi] - p[lo]
    const f = span > 0 ? (target - p[lo]) / span : 0
    return lo + f
  }
}

/** Full video length including the intro fly-in and the outro pull-back. */
export function totalDuration(cfg: RenderConfig, tl: Timeline): number {
  const intro = cfg.showIntro ? Math.max(0, cfg.introDuration) : 0
  const outro = cfg.showOutro ? Math.max(0, cfg.outroDuration) : 0
  return intro + tl.videoDuration + outro
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
