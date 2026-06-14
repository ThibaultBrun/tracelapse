<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Stage from './components/Stage.vue'
import {
  RESOLUTIONS,
  WIDGET_PRESETS,
  loadDemo,
  loadFiles,
  state,
} from './store'
import {
  connectStrava,
  consumeStravaRedirect,
  disconnectStrava,
  fetchStravaActivities,
  loadStravaActivity,
  strava,
  stravaConnected,
  type StravaActivity,
} from './strava'
import { MAP_STYLES } from './core/tiles'
import { SUMMARY_CATALOG, WIDGET_CATALOG } from './core/widgets'
import { SPEED_MAX, SPEED_MIN, sliderToSpeed, speedToSlider } from './core/timeline'
import type { WidgetKind } from './core/types'

const dragOver = ref(false)

function onDrop(e: DragEvent) {
  dragOver.value = false
  if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files)
}
function onPick(e: Event) {
  const f = (e.target as HTMLInputElement).files
  if (f) loadFiles(f)
}

const speedPos = computed({
  get: () => speedToSlider(state.timeline.speed),
  set: (v: number) => {
    state.timeline.speed = sliderToSpeed(v)
  },
})

const resIndex = computed({
  get: () =>
    RESOLUTIONS.findIndex(
      (r) => r.width === state.render.width && r.height === state.render.height,
    ),
  set: (i: number) => {
    const r = RESOLUTIONS[i]
    if (r) {
      state.render.width = r.width
      state.render.height = r.height
    }
  },
})

function toggleWidget(k: WidgetKind) {
  const i = state.render.widgets.indexOf(k)
  if (i >= 0) state.render.widgets.splice(i, 1)
  else state.render.widgets.push(k)
}

function applyPreset(widgets: WidgetKind[]) {
  state.render.widgets = widgets.filter((w) =>
    WIDGET_CATALOG.find((c) => c.kind === w)?.available(state.activity!.stats),
  )
}

const availableWidgets = computed(() =>
  WIDGET_CATALOG.filter((w) => (state.activity ? w.available(state.activity.stats) : true)),
)

function fmtKm(m: number) {
  return (m / 1000).toFixed(1)
}
function fmtDate(s: string) {
  return s ? s.slice(0, 10) : ''
}
function pickStrava(a: StravaActivity) {
  loadStravaActivity(a)
}

const availableSummary = computed(() =>
  SUMMARY_CATALOG.filter((m) => (state.activity ? m.available(state.activity.stats) : true)),
)
function toggleSummary(key: string) {
  const i = state.render.summaryStats.indexOf(key)
  if (i >= 0) state.render.summaryStats.splice(i, 1)
  else state.render.summaryStats.push(key)
}

const MARKER_ICONS = [
  'dot', '🚴', '🏃', '🥾', '🏍️', '🚗', '⛷️', '🏂',
  '🏄', '🛶', '🚣', '🪁', '⛵', '🤿', '🏊', '📍',
]

onMounted(consumeStravaRedirect)
</script>

<template>
  <div class="app">
    <header class="topbar">
      <h1>🎬 Tracelapse</h1>
      <p class="tag">GPX → cinematic video, 100% in your browser. No upload, no server.</p>
    </header>

    <main class="layout">
      <!-- LEFT: source + presets -->
      <aside
        class="panel left"
        :class="{ drag: dragOver }"
        @dragover.prevent="dragOver = true"
        @dragleave="dragOver = false"
        @drop.prevent="onDrop"
      >
        <label class="drop">
          <input type="file" accept=".gpx,.tcx,.xml" multiple @change="onPick" hidden />
          <div class="drop-inner">
            <strong>Drop a GPX / TCX file</strong>
            <span>or click to browse</span>
          </div>
        </label>

        <button class="demo" @click="loadDemo">✨ Try a demo ride</button>

        <p v-if="state.error" class="error">⚠ {{ state.error }}</p>
        <p v-if="state.loading" class="muted">Parsing…</p>

        <section v-if="state.activity" class="stats">
          <h3>{{ state.activity.name }}</h3>
          <ul>
            <li><span>Distance</span><b>{{ (state.activity.stats.totalDistance / 1000).toFixed(2) }} km</b></li>
            <li v-if="state.activity.stats.hasEle"><span>Elev. gain</span><b>{{ Math.round(state.activity.stats.totalGain) }} m</b></li>
            <li v-if="state.activity.stats.hasTime"><span>Duration</span><b>{{ Math.round(state.activity.stats.duration / 60) }} min</b></li>
            <li><span>Avg speed</span><b>{{ (state.activity.stats.avgSpeed * 3.6).toFixed(1) }} km/h</b></li>
            <li v-if="state.activity.stats.hasHr"><span>Avg HR</span><b>{{ Math.round(state.activity.stats.avgHr!) }} bpm</b></li>
            <li><span>Points</span><b>{{ state.activity.points.length }}</b></li>
          </ul>
        </section>

        <section class="sync">
          <h4>🔗 Strava</h4>
          <template v-if="!stravaConnected()">
            <button class="strava-btn" @click="connectStrava">Connect with Strava</button>
            <p v-if="strava.error" class="error">⚠ {{ strava.error }}</p>
          </template>
          <template v-else>
            <div class="strava-head">
              <span class="muted">Connected{{ strava.athlete ? ` · ${strava.athlete}` : '' }}</span>
              <button class="link" @click="disconnectStrava">disconnect</button>
            </div>
            <button class="link" :disabled="strava.loading" @click="fetchStravaActivities">↻ Refresh</button>
            <p v-if="strava.loading" class="muted">Loading activities…</p>
            <p v-if="strava.error" class="error">⚠ {{ strava.error }}</p>
            <ul class="acts">
              <li
                v-for="a in strava.activities"
                :key="a.id"
                :class="{ disabled: !a.has_latlng }"
                @click="a.has_latlng && pickStrava(a)"
              >
                <span class="an">{{ a.name }}</span>
                <span class="am">{{ fmtDate(a.start_date_local) }} · {{ fmtKm(a.distance) }} km{{ a.has_latlng ? '' : ' · no GPS' }}</span>
              </li>
            </ul>
          </template>
        </section>
      </aside>

      <!-- CENTER: preview -->
      <section class="center">
        <Stage />
      </section>

      <!-- RIGHT: controls -->
      <aside class="panel right" v-if="state.activity">
        <section class="group">
          <h4>Speed &amp; duration</h4>
          <div class="seg">
            <button :class="{ on: state.timeline.mode === 'speed' }" @click="state.timeline.mode = 'speed'">By speed</button>
            <button :class="{ on: state.timeline.mode === 'target' }" @click="state.timeline.mode = 'target'">By final length</button>
          </div>
          <template v-if="state.timeline.mode === 'speed'">
            <label class="row">
              <span>Speed</span>
              <b class="val">{{ state.timeline.speed }}×</b>
            </label>
            <input type="range" min="0" max="1" step="0.001" v-model.number="speedPos" />
            <div class="ticks"><span>{{ SPEED_MIN }}×</span><span>~14×</span><span>{{ SPEED_MAX }}×</span></div>
          </template>
          <template v-else>
            <label class="row">
              <span>Final length</span>
              <b class="val">{{ state.timeline.targetDuration }}s</b>
            </label>
            <input type="range" min="3" max="120" step="1" v-model.number="state.timeline.targetDuration" />
          </template>
          <label class="row" style="margin-top:10px"><span>Pacing</span>
            <b class="val">{{ Math.round(state.timeline.pacing * 100) }}% speed</b>
          </label>
          <input type="range" min="0" max="1" step="0.05" v-model.number="state.timeline.pacing" />
          <div class="ticks"><span>Distance (smooth)</span><span>Real speed</span></div>
        </section>

        <section class="group">
          <h4>Basemap</h4>
          <div class="chips">
            <button
              v-for="m in MAP_STYLES"
              :key="m.id"
              :class="{ on: state.render.mapStyleId === m.id }"
              @click="state.render.mapStyleId = m.id"
            >{{ m.label }}</button>
          </div>
        </section>

        <section class="group">
          <h4>Camera</h4>
          <div class="seg">
            <button :class="{ on: state.render.camera === 'follow' }" @click="state.render.camera = 'follow'">Follow rider</button>
            <button :class="{ on: state.render.camera === 'fit' }" @click="state.render.camera = 'fit'">Whole route</button>
          </div>
          <template v-if="state.render.camera === 'follow'">
            <label class="row"><span>Zoom</span><b class="val">{{ state.render.followZoom }}</b></label>
            <input type="range" min="9" max="18" step="1" v-model.number="state.render.followZoom" />
          </template>
          <label class="check">
            <input type="checkbox" v-model="state.render.showFullRoute" /> Show full route ghost
          </label>
          <label class="check">
            <input type="checkbox" v-model="state.render.rotateWithHeading" /> Rotate camera with direction
          </label>
        </section>

        <section class="group">
          <h4>3D terrain</h4>
          <label class="check">
            <input type="checkbox" v-model="state.render.terrain3d" /> Enable 3D relief
          </label>
          <template v-if="state.render.terrain3d">
            <label class="row"><span>Tilt</span><b class="val">{{ state.render.pitch }}°</b></label>
            <input type="range" min="0" max="80" step="1" v-model.number="state.render.pitch" />
            <label class="row"><span>Relief boost</span><b class="val">{{ state.render.terrainExaggeration.toFixed(1) }}×</b></label>
            <input type="range" min="1" max="3" step="0.1" v-model.number="state.render.terrainExaggeration" />
          </template>
        </section>

        <section class="group">
          <h4>Data widgets</h4>
          <div class="presets">
            <button v-for="p in WIDGET_PRESETS" :key="p.label" @click="applyPreset(p.widgets)">{{ p.label }}</button>
          </div>
          <div class="chips">
            <button
              v-for="w in availableWidgets"
              :key="w.kind"
              :class="{ on: state.render.widgets.includes(w.kind) }"
              @click="toggleWidget(w.kind)"
            >{{ w.icon }} {{ w.label }}</button>
          </div>
        </section>

        <section class="group">
          <h4>Marker</h4>
          <div class="chips">
            <button
              v-for="ic in MARKER_ICONS"
              :key="ic"
              :class="{ on: state.render.markerIcon === ic }"
              @click="state.render.markerIcon = ic"
            >{{ ic === 'dot' ? '● dot' : ic }}</button>
          </div>
        </section>

        <section class="group">
          <h4>Intro &amp; outro</h4>
          <label class="check"><input type="checkbox" v-model="state.render.showIntro" /> Intro (zoom from space + title)</label>
          <label class="check"><input type="checkbox" v-model="state.render.showOutro" /> Outro (zoom out + site address)</label>
          <p class="muted" style="margin:6px 0 0">Summary stats shown on intro/outro:</p>
          <div class="chips">
            <button
              v-for="m in availableSummary"
              :key="m.key"
              :class="{ on: state.render.summaryStats.includes(m.key) }"
              @click="toggleSummary(m.key)"
            >{{ m.label }}</button>
          </div>
        </section>

        <section class="group">
          <h4>Format</h4>
          <select v-model.number="resIndex">
            <option v-for="(r, i) in RESOLUTIONS" :key="i" :value="i">{{ r.label }} ({{ r.width }}×{{ r.height }})</option>
          </select>
          <label class="row"><span>FPS</span>
            <select v-model.number="state.render.fps">
              <option :value="24">24</option>
              <option :value="30">30</option>
              <option :value="60">60</option>
            </select>
          </label>
          <label class="row"><span>Units</span>
            <select v-model="state.render.units">
              <option value="metric">Metric</option>
              <option value="imperial">Imperial</option>
            </select>
          </label>
        </section>

        <section class="group">
          <h4>Style</h4>
          <label class="row"><span>Accent</span><input type="color" v-model="state.render.accentColor" /></label>
          <label class="row"><span>Track</span><input type="color" v-model="state.render.trackColor" /></label>
          <label class="row"><span>Track width</span><b class="val">{{ state.render.trackWidth }}</b></label>
          <input type="range" min="2" max="14" step="1" v-model.number="state.render.trackWidth" />
          <label class="row"><span>Marker size</span><b class="val">{{ state.render.markerSize }}</b></label>
          <input type="range" min="5" max="22" step="1" v-model.number="state.render.markerSize" />
          <label class="check"><input type="checkbox" v-model="state.render.showTitle" /> Show title</label>
          <input v-if="state.render.showTitle" class="text" type="text" v-model="state.render.title" placeholder="Title" />
        </section>
      </aside>
    </main>
  </div>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: baseline;
  gap: 14px;
  padding: 14px 20px;
  border-bottom: 1px solid #3a342a;
}
.topbar h1 { font-size: 18px; margin: 0; }
.tag { color: #b3a890; font-size: 13px; margin: 0; flex: 1; }
.gh { color: var(--accent); text-decoration: none; font-weight: 600; font-size: 13px; }
.layout {
  display: grid;
  grid-template-columns: 280px 1fr 320px;
  gap: 16px;
  padding: 16px;
  align-items: start;
}
.panel {
  background: #2d2820;
  border: 1px solid #3a342a;
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: calc(100vh - 110px);
  overflow-y: auto;
}
.panel.left.drag { border-color: var(--accent); }
.center { display: flex; justify-content: center; }
.drop {
  display: block;
  border: 2px dashed #4a4234;
  border-radius: 10px;
  padding: 22px 12px;
  text-align: center;
  cursor: pointer;
}
.drop:hover { border-color: var(--accent); }
.demo {
  background: transparent;
  border: 1px solid #4a4234;
  color: #e9e1d2;
  padding: 9px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}
.demo:hover { border-color: var(--accent); color: #fff; }
.drop-inner { display: flex; flex-direction: column; gap: 4px; }
.drop-inner strong { color: #f4efe6; }
.drop-inner span { color: #b3a890; font-size: 12px; }
.error { color: #ff6b6b; font-size: 13px; }
.muted { color: #b3a890; font-size: 12px; }
.stats h3 { margin: 0 0 8px; font-size: 14px; }
.stats ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.stats li { display: flex; justify-content: space-between; font-size: 13px; }
.stats li span { color: #b3a890; }
.group h4 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #b3a890; }
.seg, .presets { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.seg button, .presets button {
  flex: 1;
  background: #38322a;
  border: 1px solid #4a4234;
  color: #e9e1d2;
  padding: 7px 8px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 12px;
}
.seg button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chips button {
  background: #38322a;
  border: 1px solid #4a4234;
  color: #e9e1d2;
  padding: 6px 10px;
  border-radius: 16px;
  cursor: pointer;
  font-size: 12px;
}
.chips button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.row { display: flex; align-items: center; justify-content: space-between; font-size: 13px; color: #e9e1d2; margin: 6px 0 2px; }
.row .val { color: var(--accent); }
.ticks { display: flex; justify-content: space-between; color: #9c9078; font-size: 11px; }
.check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #e9e1d2; margin-top: 6px; }
input[type='range'] { width: 100%; accent-color: var(--accent); }
select, .text {
  width: 100%;
  background: #38322a;
  border: 1px solid #4a4234;
  color: #f4efe6;
  border-radius: 7px;
  padding: 7px;
  font-size: 13px;
}
.row select { width: auto; }
input[type='color'] { width: 42px; height: 28px; border: none; background: none; padding: 0; }
.sync h4 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #b3a890; }
.strava-btn {
  width: 100%;
  background: #fc4c02;
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 10px;
  font-weight: 700;
  cursor: pointer;
}
.strava-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.link { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 12px; padding: 0; }
.link:disabled { opacity: 0.5; }
.acts { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow-y: auto; }
.acts li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 9px;
  border: 1px solid #4a4234;
  border-radius: 7px;
  cursor: pointer;
}
.acts li:hover { border-color: var(--accent); }
.acts li.disabled { opacity: 0.4; cursor: default; }
.acts li.disabled:hover { border-color: #4a4234; }
.acts .an { font-size: 13px; color: #f4efe6; }
.acts .am { font-size: 11px; color: #b3a890; }
@media (max-width: 1100px) {
  .layout { grid-template-columns: 1fr; }
  .panel { max-height: none; }
}
</style>
