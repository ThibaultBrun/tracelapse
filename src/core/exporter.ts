import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from 'webm-muxer'
import { ArrayBufferTarget as Mp4Target, Muxer as Mp4Muxer } from 'mp4-muxer'
import type { MapScene } from './mapscene'
import { totalDuration, type Timeline } from './timeline'
import type { Activity, RenderConfig } from './types'
import { drawOverlay, type OverlayCtx } from './overlay'

export interface ExportProgress {
  phase: 'warmup' | 'recording' | 'encoding'
  ratio: number
}

export interface ExportResult {
  blob: Blob
  ext: 'mp4' | 'webm'
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Export the 3D scene to a WebM blob, fully in-browser.
 *
 * Preferred path: WebCodecs VideoEncoder, frame-stepped. For each video frame we
 * position the camera, wait for tiles + terrain to settle, composite the map and
 * the data overlay, then encode with an explicit timestamp. This is frame-exact
 * (correct duration, never a blank frame) and independent of render speed.
 *
 * Fallback (no WebCodecs): real-time MediaRecorder capture of the same composite.
 */
export async function exportVideo(
  scene: MapScene,
  timeline: Timeline,
  act: Activity,
  cfg: RenderConfig,
  onProgress: (p: ExportProgress) => void,
  signal?: { cancelled: boolean },
): Promise<ExportResult> {
  // Detached composite canvas. It must NOT be appended on-screen over the map:
  // an opaque overlay would occlude MapLibre and freeze its drawing buffer
  // (black frames). WebCodecs reads the canvas backing store directly, so it
  // never needs to be in the DOM; the map stays visible and keeps rendering.
  const out = document.createElement('canvas')
  out.width = cfg.width
  out.height = cfg.height
  const ctx = out.getContext('2d', { alpha: false })!
  const overlayCtx: OverlayCtx = { act, cfg, timeline, attribution: scene.attribution, currentTrail: () => scene.currentTrail }

  const composeFrame = async (t: number) => {
    scene.seek(t)
    await scene.captureInto(ctx, out.width, out.height, 4000)
    drawOverlay(ctx, overlayCtx, t, false)
  }

  if (typeof VideoEncoder !== 'undefined') {
    return await encodeWebCodecs(out, scene, timeline, cfg, composeFrame, onProgress, signal)
  }
  return await encodeMediaRecorder(out, ctx, scene, timeline, overlayCtx, cfg, onProgress, signal)
}

/** Prefer H.264/MP4 (Instagram-friendly, shareable) when the platform can encode
 *  it; otherwise fall back to VP9/WebM. */
async function pickWebCodec(
  cfg: RenderConfig,
): Promise<{ ext: 'mp4' | 'webm'; codec: string; mp4: boolean }> {
  const bitrate = Math.round(cfg.width * cfg.height * cfg.fps * 0.12)
  const supported = async (codec: string, extra: Record<string, unknown> = {}) => {
    try {
      const r = await VideoEncoder.isConfigSupported({
        codec,
        width: cfg.width,
        height: cfg.height,
        bitrate,
        framerate: cfg.fps,
        ...extra,
      })
      return !!r.supported
    } catch {
      return false
    }
  }
  for (const c of ['avc1.640028', 'avc1.42002a', 'avc1.42001f']) {
    if (await supported(c, { avc: { format: 'avc' } })) return { ext: 'mp4', codec: c, mp4: true }
  }
  return { ext: 'webm', codec: 'vp09.00.10.08', mp4: false }
}

async function encodeWebCodecs(
  out: HTMLCanvasElement,
  _scene: MapScene,
  timeline: Timeline,
  cfg: RenderConfig,
  composeFrame: (t: number) => Promise<void>,
  onProgress: (p: ExportProgress) => void,
  signal?: { cancelled: boolean },
): Promise<ExportResult> {
  const duration = totalDuration(cfg, timeline)
  const fps = cfg.fps
  const total = Math.max(1, Math.round(duration * fps))
  const usPerFrame = 1_000_000 / fps
  const bitrate = Math.round(cfg.width * cfg.height * fps * 0.12)
  const fmt = await pickWebCodec(cfg)

  const mp4 = fmt.mp4
    ? new Mp4Muxer({
        target: new Mp4Target(),
        video: { codec: 'avc', width: cfg.width, height: cfg.height },
        fastStart: 'in-memory',
      })
    : null
  const webm = fmt.mp4
    ? null
    : new WebmMuxer({
        target: new WebmTarget(),
        video: { codec: 'V_VP9', width: cfg.width, height: cfg.height, frameRate: fps },
        firstTimestampBehavior: 'offset',
      })

  const encoder = new VideoEncoder({
    output: (chunk, meta) => (mp4 ? mp4.addVideoChunk(chunk, meta) : webm!.addVideoChunk(chunk, meta)),
    error: (e) => console.error('[tracelapse] encoder', e),
  })
  encoder.configure({
    codec: fmt.codec,
    width: cfg.width,
    height: cfg.height,
    bitrate,
    framerate: fps,
    ...(fmt.mp4 ? { avc: { format: 'avc' } } : {}),
  })

  for (let i = 0; i < total; i++) {
    if (signal?.cancelled) {
      encoder.close()
      throw new Error('cancelled')
    }
    const t = Math.min(duration, i / fps)
    await composeFrame(t)
    const frame = new VideoFrame(out, { timestamp: Math.round(i * usPerFrame), duration: Math.round(usPerFrame) })
    encoder.encode(frame, { keyFrame: i % fps === 0 })
    frame.close()
    // Backpressure: don't let the encode queue run away on slow machines.
    while (encoder.encodeQueueSize > 6) await sleep(4)
    onProgress({ phase: 'recording', ratio: (i + 1) / total })
  }
  onProgress({ phase: 'encoding', ratio: 1 })
  await encoder.flush()
  encoder.close()
  if (mp4) {
    mp4.finalize()
    return { blob: new Blob([mp4.target.buffer], { type: 'video/mp4' }), ext: 'mp4' }
  }
  webm!.finalize()
  return { blob: new Blob([webm!.target.buffer], { type: 'video/webm' }), ext: 'webm' }
}

// --- Fallback: real-time MediaRecorder (used only when WebCodecs is absent) ---
function pickMime(): string {
  const c = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  for (const m of c) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m
  return 'video/webm'
}

async function encodeMediaRecorder(
  out: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  timeline: Timeline,
  overlayCtx: OverlayCtx,
  cfg: RenderConfig,
  onProgress: (p: ExportProgress) => void,
  signal?: { cancelled: boolean },
): Promise<ExportResult> {
  const duration = totalDuration(cfg, timeline)
  // captureStream only ticks while the canvas is composited on-screen — but it
  // must not cover the map (that would freeze MapLibre). Park it as a small
  // on-screen thumbnail; the full-resolution backing store is still captured.
  out.style.cssText =
    'position:fixed;right:8px;bottom:8px;width:120px;height:auto;z-index:45;' +
    'border-radius:6px;opacity:0.9;pointer-events:none'
  document.body.appendChild(out)

  // Warm-up: cache tiles along the route so real-time frames aren't blank.
  const steps = 12
  for (let i = 0; i <= steps; i++) {
    if (signal?.cancelled) {
      out.remove()
      throw new Error('cancelled')
    }
    scene.seek((i / steps) * duration)
    await scene.renderSettled(2200)
    onProgress({ phase: 'warmup', ratio: i / steps })
  }

  const stream = out.captureStream(cfg.fps)
  const mime = pickMime()
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: Math.round(cfg.width * cfg.height * 30 * 0.12),
  })
  const chunks: BlobPart[] = []
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
  const finished = new Promise<Blob>((res) => {
    recorder.onstop = () => res(new Blob(chunks, { type: mime }))
  })

  recorder.start(500)
  const start = performance.now()
  for (;;) {
    if (signal?.cancelled) break
    const elapsed = (performance.now() - start) / 1000
    const t = Math.min(duration, elapsed)
    scene.seek(t)
    ctx.drawImage(scene.map.getCanvas(), 0, 0, out.width, out.height)
    drawOverlay(ctx, overlayCtx, t, false)
    onProgress({ phase: 'recording', ratio: t / duration })
    if (elapsed >= duration) break
    await new Promise((r) => requestAnimationFrame(() => r(null)))
  }
  onProgress({ phase: 'encoding', ratio: 1 })
  await sleep(300)
  recorder.stop()
  const blob = await finished
  out.remove()
  return { blob, ext: 'webm' }
}
