// Generates a realistic sample MTB ride GPX near Col d'Ibardin (FR/ES border).
import { writeFileSync } from 'node:fs'

const N = 720 // ~24 min at 2s cadence
const start = Date.UTC(2026, 5, 7, 8, 30, 0)
const lat0 = 43.3186
const lon0 = -1.6357

let lat = lat0
let lon = lon0
let ele = 120
const pts = []
for (let i = 0; i < N; i++) {
  const tt = i / N
  // a loop-ish path
  const ang = tt * Math.PI * 2
  lat = lat0 + 0.0072 * Math.sin(ang) + 0.0018 * Math.sin(ang * 5)
  lon = lon0 + 0.0095 * Math.cos(ang) + 0.0022 * Math.cos(ang * 4)
  // climb first half, descend second half
  ele = 120 + 340 * Math.sin(tt * Math.PI) + 10 * Math.sin(ang * 9)
  const speed = 4 + 3 * Math.sin(ang * 3) + (tt > 0.5 ? 4 : 0) // m/s
  const hr = Math.round(128 + 38 * Math.sin(tt * Math.PI) + 6 * Math.sin(ang * 7))
  const cad = Math.round(70 + 18 * Math.sin(ang * 3))
  const time = new Date(start + i * 2000).toISOString()
  pts.push({ lat, lon, ele, hr, cad, time, speed })
}

const trkpts = pts
  .map(
    (p) => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">
        <ele>${p.ele.toFixed(1)}</ele>
        <time>${p.time}</time>
        <extensions><gpxtpx:TrackPointExtension>
          <gpxtpx:hr>${p.hr}</gpxtpx:hr>
          <gpxtpx:cad>${p.cad}</gpxtpx:cad>
        </gpxtpx:TrackPointExtension></extensions>
      </trkpt>`,
  )
  .join('\n')

const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="tracelapse-sample"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <trk>
    <name>Boucle Col d'Ibardin</name>
    <type>cycling</type>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`

writeFileSync(new URL('../public/sample.gpx', import.meta.url), gpx)
console.log('wrote public/sample.gpx', pts.length, 'points')
