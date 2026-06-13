import type { Renderer } from './renderer'
import type { Timeline } from './timeline'
import { preloadTiles, styleById } from './tiles'

export interface ExportProgress {
  phase: 'tiles' | 'recording' | 'encoding'
  ratio: number
}

function pickMime(): string {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c
  }
  return 'video/webm'
}

/**
 * Render the animation to a WebM blob entirely in-browser:
 *  1. preload every map tile so no frame is blank,
 *  2. play the timeline in real time while MediaRecorder captures the canvas.
 */
export async function exportVideo(
  renderer: Renderer,
  timeline: Timeline,
  styleId: string,
  fps: number,
  onProgress: (p: ExportProgress) => void,
  signal?: { cancelled: boolean },
): Promise<Blob> {
  // 1. Preload tiles.
  const tiles = renderer.planTiles()
  await preloadTiles(styleById(styleId), tiles, (done, total) =>
    onProgress({ phase: 'tiles', ratio: total ? done / total : 1 }),
  )
  if (signal?.cancelled) throw new Error('cancelled')

  // 2. Record.
  const duration = timeline.videoDuration
  const stream = renderer.canvas.captureStream(fps)
  const mime = pickMime()
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: estimateBitrate(renderer.canvas.width, renderer.canvas.height),
  })
  const chunks: BlobPart[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }

  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }))
  })

  recorder.start()
  const start = performance.now()
  await new Promise<void>((resolve) => {
    function frame() {
      if (signal?.cancelled) {
        resolve()
        return
      }
      const elapsed = (performance.now() - start) / 1000
      const t = Math.min(duration, elapsed)
      renderer.renderAt(t)
      onProgress({ phase: 'recording', ratio: t / duration })
      if (elapsed >= duration) {
        resolve()
        return
      }
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })

  onProgress({ phase: 'encoding', ratio: 1 })
  recorder.stop()
  const blob = await done
  if (signal?.cancelled) throw new Error('cancelled')
  return blob
}

function estimateBitrate(w: number, h: number): number {
  // ~0.12 bits per pixel per frame at 30fps -> scales with resolution.
  const px = w * h
  return Math.round(px * 30 * 0.12)
}
