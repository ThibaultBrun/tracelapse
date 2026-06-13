import type { Activity, RenderConfig, TimelineConfig } from './types'

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
   * Map a video time -> fractional point index along the de-paused (playT) axis,
   * so stopped stretches are skipped and the animation flows continuously.
   */
  indexAtVideoTime(videoT: number): number {
    const frac = Math.min(1, Math.max(0, videoT / this.videoDuration))
    const playPos = frac * this.playDuration
    return this.indexAtPlayTime(playPos)
  }

  /** Binary-search the derived[].playT axis -> fractional index. */
  private indexAtPlayTime(playPos: number): number {
    const d = this.act.derived
    let lo = 0
    let hi = d.length - 1
    if (playPos <= d[0].playT) return 0
    if (playPos >= d[hi].playT) return hi
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (d[mid].playT <= playPos) lo = mid
      else hi = mid
    }
    const span = d[hi].playT - d[lo].playT
    const f = span > 0 ? (playPos - d[lo].playT) / span : 0
    return lo + f
  }
}

/** Full video length including the intro fly-in. */
export function totalDuration(cfg: RenderConfig, tl: Timeline): number {
  return (cfg.showIntro ? Math.max(0, cfg.introDuration) : 0) + tl.videoDuration
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
