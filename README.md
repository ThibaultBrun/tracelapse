# 🎬 Tracelapse

**Turn your GPS activities into cinematic, fully-configurable videos — 100% in your browser.**
No upload, no server, no account. Your GPX never leaves your machine.

![Tracelapse screenshot](docs/screenshot.png)

There are plenty of "GPX to video" tools out there, but they're locked down:
fixed speed, fixed layout, watermark, paywall. Tracelapse is the opposite —
every knob is exposed, and the heavy lifting (parsing, map rendering, **video
encoding**) all runs client-side via the Canvas + MediaRecorder APIs.

## Features

- **Drop a GPX or TCX file** (Strava, Garmin, Komoot, Wahoo… all export these).
- **Exponential speed control, ×1 → ×200** — fine at walking pace, huge for long
  rides. Or switch to **"by final length"** and set the exact video duration.
- **Choose your basemap**: OpenStreetMap, OpenTopoMap, Satellite (Esri),
  Carto Dark / Light / Voyager.
- **Pick what to show** — speed, pace, distance, elevation, elevation gain,
  grade, heart rate, cadence, power, temperature, elapsed time, time of day,
  plus a live **elevation profile** graph. The app auto-detects which streams
  your file actually contains.
- **Predefined widget presets**: Minimal · Performance · Mountain · Full.
- **Camera modes**: follow the rider (with zoom control) or frame the whole route.
- Customisable accent colour, track colour/width, marker size, title, units
  (metric / imperial), resolution (9:16 reels, 16:9, 1:1, 720p) and 24/30/60 fps.
- **Export to WebM**, entirely offline. Tiles are preloaded first so no frame is
  ever blank.

## Quick start

```sh
npm install
npm run dev      # http://localhost:5173
```

Open the app, click **"✨ Try a demo ride"** (or drop your own `.gpx`), tweak,
hit **Export**.

```sh
npm run build    # type-check + production build into dist/
npm run preview  # serve the built app
```

## How it works

```
GPX/TCX ──▶ parser ──▶ metrics (distance, speed, gain, grade, smoothing)
                              │
                         Timeline (real time ⇄ video time, ×N or target length)
                              │
                    Canvas2D Renderer (map tiles + route + marker + widgets)
                              │
              ┌───────────────┴───────────────┐
        live preview                   exporter (preload tiles →
        (requestAnimationFrame)         MediaRecorder → .webm)
```

Everything in `src/core/` is framework-agnostic TypeScript:

| Module | Role |
|---|---|
| `gpx.ts` | Parse GPX & TCX, including Garmin `TrackPointExtension` (hr/cad/power/temp) |
| `metrics.ts` | Cumulative distance, smoothed speed, elevation gain, grade, stats, interpolation |
| `tiles.ts` | Web-Mercator math, CORS-clean tile loading & caching, basemap catalog |
| `timeline.ts` | Maps video time → track index; exponential speed slider helpers |
| `renderer.ts` | The Canvas2D scene: tiles, route, marker, widget chips, elevation profile |
| `exporter.ts` | Preloads tiles then records the canvas to WebM via `MediaRecorder` |
| `widgets.ts` | Widget catalog, availability per activity, value formatting |

The UI (Vue 3) is a thin layer over a single reactive `store`.

## Strava / Garmin auto-sync

Auto-sync is intentionally **opt-in** and lives in [`serverless/`](serverless/).
OAuth with Strava/Garmin needs a `client_secret` that can't ship in a static
site, so a tiny Cloudflare Worker handles the token exchange and hands the
front-end a GPX. See [`serverless/README.md`](serverless/README.md). Until you
deploy it, just export a GPX from Strava/Garmin and drop it in — same result.

## Notes & limits

- Export format is **WebM** (VP9/VP8), the format `MediaRecorder` produces
  natively in-browser. Convert to MP4 with any tool (or a future ffmpeg.wasm
  step) if a platform needs it.
- Recording is real-time: a 30 s video takes ~30 s to capture.
- Map tiles come from public providers — respect their usage policies; the
  on-screen attribution is baked into every frame.

## Tech

Vue 3 · TypeScript · Vite · HTML Canvas 2D · MediaRecorder. No map library, no
backend, no tracking.

## License

MIT © Thibault Brun
