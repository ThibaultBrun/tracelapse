<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { state } from '../store'
import { Renderer } from '../core/renderer'
import { Timeline } from '../core/timeline'
import { exportVideo, type ExportProgress } from '../core/exporter'
import { fmtDuration } from '../core/widgets'

const canvasRef = ref<HTMLCanvasElement | null>(null)
const renderer = shallowRef<Renderer | null>(null)
const timeline = shallowRef<Timeline | null>(null)

const playing = ref(false)
const videoTime = ref(0)
const exporting = ref(false)
const exportMsg = ref('')
const exportRatio = ref(0)
const cancelSignal = { cancelled: false }

let rafId = 0
let lastTs = 0

const duration = computed(() => timeline.value?.videoDuration ?? 0)
const effSpeed = computed(() => Math.round(timeline.value?.effectiveSpeed ?? 0))

function rebuild() {
  const act = state.activity
  const cv = canvasRef.value
  if (!act || !cv) {
    renderer.value = null
    timeline.value = null
    return
  }
  const tl = new Timeline(act, state.timeline)
  const rd = new Renderer(cv, act, state.render, tl)
  // Refresh a paused preview as async tiles arrive (playback drives its own loop).
  rd.onTileLoad = () => {
    if (!playing.value) rd.renderAt(videoTime.value)
  }
  timeline.value = tl
  renderer.value = rd
  if (videoTime.value > tl.videoDuration) videoTime.value = 0
  rd.renderAt(videoTime.value)
}

// Rebuild renderer when the activity changes.
watch(() => state.activity, rebuild)

// Reconfigure on render-config change (keep current frame).
watch(
  () => ({ ...state.render }),
  () => {
    if (!renderer.value) {
      rebuild()
      return
    }
    renderer.value.setConfig(state.render)
    renderer.value.renderAt(videoTime.value)
  },
  { deep: true },
)

// Rebuild timeline on timeline-config change.
watch(
  () => ({ ...state.timeline }),
  () => {
    const act = state.activity
    if (!act || !renderer.value) return
    const tl = new Timeline(act, state.timeline)
    timeline.value = tl
    renderer.value.setTimeline(tl)
    if (videoTime.value > tl.videoDuration) videoTime.value = tl.videoDuration
    renderer.value.renderAt(videoTime.value)
  },
  { deep: true },
)

function tick(ts: number) {
  if (!playing.value || !timeline.value || !renderer.value) return
  if (!lastTs) lastTs = ts
  const dt = (ts - lastTs) / 1000
  lastTs = ts
  videoTime.value += dt
  if (videoTime.value >= timeline.value.videoDuration) {
    videoTime.value = timeline.value.videoDuration
    renderer.value.renderAt(videoTime.value)
    stop()
    return
  }
  renderer.value.renderAt(videoTime.value)
  rafId = requestAnimationFrame(tick)
}

function play() {
  if (!timeline.value) return
  if (videoTime.value >= timeline.value.videoDuration) videoTime.value = 0
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
  renderer.value?.renderAt(videoTime.value)
}

async function doExport() {
  if (!renderer.value || !timeline.value) return
  stop()
  exporting.value = true
  cancelSignal.cancelled = false
  videoTime.value = 0
  try {
    const blob = await exportVideo(
      renderer.value,
      timeline.value,
      state.render.mapStyleId,
      state.render.fps,
      (p: ExportProgress) => {
        exportRatio.value = p.ratio
        exportMsg.value =
          p.phase === 'tiles'
            ? `Loading map tiles… ${Math.round(p.ratio * 100)}%`
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
    renderer.value?.renderAt(videoTime.value)
  }
}

function cancelExport() {
  cancelSignal.cancelled = true
}

onBeforeUnmount(stop)
defineExpose({ rebuild })
</script>

<template>
  <div class="stage">
    <div class="canvas-wrap" :style="{ aspectRatio: `${state.render.width} / ${state.render.height}` }">
      <canvas ref="canvasRef" class="canvas" />
      <div v-if="!state.activity" class="empty-hint">Drop a GPX/TCX file to begin</div>
    </div>

    <div v-if="state.activity" class="transport">
      <button class="play" @click="toggle">{{ playing ? '❚❚' : '▶' }}</button>
      <input
        class="scrub"
        type="range"
        min="0"
        :max="duration"
        step="0.01"
        :value="videoTime"
        @input="onScrub"
      />
      <span class="time">{{ fmtDuration(videoTime) }} / {{ fmtDuration(duration) }}</span>
    </div>

    <div v-if="state.activity" class="export-bar">
      <div class="meta">
        <span>⏱ {{ duration.toFixed(1) }}s video</span>
        <span>· {{ effSpeed }}× real time</span>
        <span>· {{ state.render.fps }} fps</span>
        <span>· {{ state.render.width }}×{{ state.render.height }}</span>
      </div>
      <button v-if="!exporting" class="export" @click="doExport">⬇ Export video (.webm)</button>
      <template v-else>
        <div class="progress"><div class="bar" :style="{ width: exportRatio * 100 + '%' }" /></div>
        <span class="export-msg">{{ exportMsg }}</span>
        <button class="cancel" @click="cancelExport">Cancel</button>
      </template>
    </div>
    <div v-if="exportMsg && !exporting" class="export-done">{{ exportMsg }}</div>
  </div>
</template>

<style scoped>
.stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  width: 100%;
}
.canvas-wrap {
  position: relative;
  max-height: 68vh;
  max-width: 100%;
  background: #0b0f14;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
}
.canvas {
  display: block;
  height: 100%;
  width: 100%;
  max-height: 68vh;
  object-fit: contain;
}
.empty-hint {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #7b8794;
  font-size: 15px;
}
.transport {
  display: flex;
  align-items: center;
  gap: 12px;
  width: min(560px, 100%);
}
.play {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: none;
  background: var(--accent);
  color: #fff;
  font-size: 15px;
  cursor: pointer;
  flex: none;
}
.scrub {
  flex: 1;
  accent-color: var(--accent);
}
.time {
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: #9aa7b4;
  min-width: 92px;
  text-align: right;
}
.export-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: center;
  width: min(560px, 100%);
}
.meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
  color: #9aa7b4;
}
.export {
  border: none;
  background: var(--accent);
  color: #fff;
  padding: 10px 18px;
  border-radius: 8px;
  font-weight: 700;
  cursor: pointer;
}
.cancel {
  border: 1px solid #3a4654;
  background: transparent;
  color: #cdd6e0;
  padding: 8px 14px;
  border-radius: 8px;
  cursor: pointer;
}
.progress {
  flex: 1;
  height: 8px;
  background: #1c2530;
  border-radius: 4px;
  overflow: hidden;
  min-width: 160px;
}
.bar {
  height: 100%;
  background: var(--accent);
  transition: width 0.1s linear;
}
.export-msg {
  font-size: 12px;
  color: #9aa7b4;
}
.export-done {
  font-size: 13px;
  color: #5dd47f;
}
</style>
