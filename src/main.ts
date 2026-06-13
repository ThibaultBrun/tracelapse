import { createApp } from 'vue'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import App from './App.vue'
import './style.css'

// Pull tiles harder so the fast-moving 3D camera has fewer holes / pop-in.
maplibregl.setMaxParallelImageRequests(48)

createApp(App).mount('#app')
