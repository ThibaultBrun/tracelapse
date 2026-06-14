<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { state } from '../store'
import { MapScene } from '../core/mapscene'
import { Timeline, totalDuration } from '../core/timeline'
import { drawOverlay, type OverlayCtx } from '../core/overlay'
import { exportVideo, type ExportProgress } from '../core/exporter'
import { fmtDuration } from '../core/widgets'

const viewport = ref<HTMLDivElement | null>(null)
const surface = ref<HTMLDivElement | null>(null)
const mapEl = ref<HTMLDivElement | null>(null)
const overlayEl = ref<HTMLCanvasElement | null>(null)
const scale = ref(1)

const scene = shallowRef<MapScene | null>(null)
const timeline = shallowRef<Timeline | null>(null)
let overlayCtx: CanvasRenderingContext2D | null = null

const playing = ref(false)
const ready = ref(false)
const busy = computed(() => state.loading || (!!state.activity && !ready.value))
const videoTime = ref(0)
const duration = ref(0)
const effSpeed = ref(0)
const exporting = ref(false)
const exportMsg = ref('')
const exportRatio = ref(0)
const cancelSignal = { cancelled: false }
let rafId = 0
let lastTs = 0

function fitScale() {
  const vp = viewport.value
  if (!vp) return
  scale.value = Math.min(vp.clientWidth / state.render.width, vp.clientHeight / state.render.height)
}

function overlayResize() {
  const c = overlayEl.value
  if (!c) return
  c.width = state.render.width
  c.height = state.render.height
  overlayCtx = c.getContext('2d')
}

function drawOv() {
  if (overlayCtx && scene.value && timeline.value) {
    drawOverlay(overlayCtx, ovCtx(), videoTime.value)
  }
}

function ovCtx(): OverlayCtx {
  return {
    act: state.activity!,
    cfg: state.render,
    timeline: timeline.value!,
    attribution: scene.value!.attribution,
  }
}

function refreshMeta() {
  if (!timeline.value) return
  duration.value = totalDuration(state.render, timeline.value)
  effSpeed.value = Math.round(timeline.value.effectiveSpeed)
}

async function rebuild() {
  stop()
  ready.value = false
  scene.value?.destroy()
  scene.value = null
  const act = state.activity
  if (!act || !mapEl.value) return
  overlayResize()
  fitScale()
  const tl = new Timeline(act, state.timeline)
  const sc = new MapScene(mapEl.value, act, state.render, tl)
  timeline.value = tl
  scene.value = sc
  refreshMeta()
  await sc.ready
  videoTime.value = 0
  sc.seek(0)
  drawOv()
  ready.value = true
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__tl = { scene: sc, timeline: tl, act }
}

watch(() => state.activity, rebuild)

watch(
  () => [state.render.width, state.render.height],
  () => {
    overlayResize()
    fitScale()
    scene.value?.resize()
    scene.value?.seek(videoTime.value)
    drawOv()
  },
)

watch(
  () => ({ ...state.render }),
  () => {
    if (!scene.value || !ready.value) return
    scene.value.setConfig(state.render)
    refreshMeta()
    scene.value.seek(videoTime.value)
    drawOv()
  },
  { deep: true },
)

watch(
  () => ({ ...state.timeline }),
  () => {
    const act = state.activity
    if (!act || !scene.value || !ready.value) return
    const tl = new Timeline(act, state.timeline)
    timeline.value = tl
    scene.value.setTimeline(tl)
    refreshMeta()
    if (videoTime.value > duration.value) videoTime.value = duration.value
    scene.value.seek(videoTime.value)
    drawOv()
  },
  { deep: true },
)

function tick(ts: number) {
  if (!playing.value || !timeline.value || !scene.value) return
  if (!lastTs) lastTs = ts
  videoTime.value += (ts - lastTs) / 1000
  lastTs = ts
  if (videoTime.value >= duration.value) {
    videoTime.value = duration.value
    scene.value.seek(videoTime.value)
    drawOv()
    stop()
    return
  }
  scene.value.seek(videoTime.value)
  drawOv()
  rafId = requestAnimationFrame(tick)
}

function play() {
  if (!timeline.value || !ready.value) return
  if (videoTime.value >= duration.value) videoTime.value = 0
  playing.value = true
  lastTs = 0
  rafId = requestAnimationFrame(tick)
}
function stop() {
  playing.value = false
  cancelAnimationFrame(rafId)
}
function toggle() {
  playing.value ? stop() : play()
}
function onScrub(e: Event) {
  stop()
  videoTime.value = Number((e.target as HTMLInputElement).value)
  scene.value?.seek(videoTime.value)
  drawOv()
}

async function doExport() {
  if (!scene.value || !timeline.value || !state.activity) return
  stop()
  exporting.value = true
  cancelSignal.cancelled = false
  videoTime.value = 0
  try {
    const blob = await exportVideo(
      scene.value,
      timeline.value,
      state.activity,
      state.render,
      (p: ExportProgress) => {
        exportRatio.value = p.ratio
        exportMsg.value =
          p.phase === 'warmup'
            ? `Loading map & terrain… ${Math.round(p.ratio * 100)}%`
            : p.phase === 'recording'
              ? `Recording… ${Math.round(p.ratio * 100)}%`
              : 'Finalising…'
      },
      cancelSignal,
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const safe = (state.render.title || 'tracelapse').replace(/[^\w-]+/g, '_').slice(0, 40)
    a.href = url
    a.download = `${safe}.webm`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
    exportMsg.value = 'Done — saved .webm'
  } catch (e) {
    exportMsg.value = (e as Error).message === 'cancelled' ? 'Cancelled' : `Error: ${(e as Error).message}`
  } finally {
    exporting.value = false
    scene.value?.seek(videoTime.value)
    drawOv()
  }
}
function cancelExport() {
  cancelSignal.cancelled = true
}

let ro: ResizeObserver | null = null
onMounted(() => {
  ro = new ResizeObserver(fitScale)
  if (viewport.value) ro.observe(viewport.value)
  if (state.activity) rebuild()
})
onBeforeUnmount(() => {
  stop()
  ro?.disconnect()
  scene.value?.destroy()
})
</script>

<template>
  <div class="stage">
    <div class="viewport" ref="viewport">
      <div
        class="surface"
        ref="surface"
        :style="{
          width: state.render.width + 'px',
          height: state.render.height + 'px',
          transform: `translate(-50%, -50%) scale(${scale})`,
        }"
      >
        <div class="map" ref="mapEl" />
        <canvas class="overlay" ref="overlayEl" />
      </div>
      <div v-if="exporting" class="busy export-cover">
        <div class="spinner" />
        <span>⚙️ Generating video… {{ Math.round(exportRatio * 100) }}%</span>
        <div class="progress"><div class="bar" :style="{ width: exportRatio * 100 + '%' }" /></div>
        <small>{{ exportMsg }}</small>
        <button class="cancel" @click="cancelExport">Cancel</button>
      </div>
      <div v-else-if="busy" class="busy">
        <div class="spinner" />
        <span>{{ state.loading ? 'Loading activity…' : 'Building 3D terrain…' }}</span>
      </div>
      <div v-else-if="!state.activity" class="empty-hint">Drop a GPX/TCX file or try the demo</div>
    </div>

    <template v-if="state.activity">
      <div class="transport">
        <button class="play" @click="toggle">{{ playing ? '❚❚' : '▶' }}</button>
        <input class="scrub" type="range" min="0" :max="duration" step="0.01" :value="videoTime" @input="onScrub" />
        <span class="time">{{ fmtDuration(videoTime) }} / {{ fmtDuration(duration) }}</span>
      </div>

      <div class="export-bar">
        <div class="meta">
          <span>⏱ {{ duration.toFixed(1) }}s</span>
          <span>· {{ effSpeed }}× real time</span>
          <span>· {{ state.render.fps }} fps</span>
          <span>· {{ state.render.width }}×{{ state.render.height }}</span>
          <span>· {{ state.render.terrain3d ? '3D' : '2D' }}</span>
        </div>
        <button v-if="!exporting" class="export" :disabled="!ready" @click="doExport">⬇ Export video (.webm)</button>
      </div>
      <div v-if="exportMsg && !exporting" class="export-done">{{ exportMsg }}</div>
    </template>
  </div>
</template>

<style scoped>
.stage { display: flex; flex-direction: column; align-items: center; gap: 14px; width: 100%; }
.viewport {
  position: relative;
  width: 100%;
  height: 70vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.surface {
  position: absolute;
  top: 50%;
  left: 50%;
  transform-origin: center center;
  border-radius: 14px;
  overflow: hidden;
  background: #1c1812;
  box-shadow: 0 16px 50px rgba(0, 0, 0, 0.5);
}
.map { position: absolute; inset: 0; }
.overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.busy {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: #e9e1d2;
  font-size: 15px;
  background: rgba(8, 12, 17, 0.66);
  backdrop-filter: blur(2px);
}
.spinner {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  border: 4px solid rgba(255, 255, 255, 0.15);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.empty-hint { color: #b3a890; font-size: 15px; }
.export-cover .progress { width: min(60%, 320px); }
.export-cover small { color: var(--text-dim); font-size: 12px; }
.export-cover .cancel { margin-top: 4px; }
.transport { display: flex; align-items: center; gap: 12px; width: min(560px, 100%); }
.play { width: 44px; height: 44px; border-radius: 50%; border: none; background: var(--accent); color: #fff; font-size: 15px; cursor: pointer; flex: none; }
.scrub { flex: 1; accent-color: var(--accent); }
.time { font-variant-numeric: tabular-nums; font-size: 13px; color: #b3a890; min-width: 92px; text-align: right; }
.export-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: center; width: min(560px, 100%); }
.meta { display: flex; gap: 6px; flex-wrap: wrap; font-size: 12px; color: #b3a890; }
.export { border: none; background: var(--accent); color: #fff; padding: 10px 18px; border-radius: 8px; font-weight: 700; cursor: pointer; }
.export:disabled { opacity: 0.5; cursor: default; }
.cancel { border: 1px solid #4a4234; background: transparent; color: #e9e1d2; padding: 8px 14px; border-radius: 8px; cursor: pointer; }
.progress { flex: 1; height: 8px; background: #38322a; border-radius: 4px; overflow: hidden; min-width: 160px; }
.bar { height: 100%; background: var(--accent); transition: width 0.1s linear; }
.export-msg { font-size: 13px; color: #f4efe6; }
.export-done { font-size: 13px; color: #5dd47f; }
.export-overlay {
  position: fixed;
  bottom: 26px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 14px;
  background: rgba(12, 17, 23, 0.92);
  border: 1px solid #4a4234;
  padding: 12px 18px;
  border-radius: 12px;
  width: min(520px, 92vw);
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
}
</style>
