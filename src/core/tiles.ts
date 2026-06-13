import type { MapStyleDef } from './types'

export const MAP_STYLES: MapStyleDef[] = [
  {
    id: 'sat',
    label: 'Aerial (Esri)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    dark: true,
    maxZoom: 19,
  },
  {
    id: 'osm',
    label: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    dark: false,
    maxZoom: 19,
  },
  {
    id: 'topo',
    label: 'OpenTopoMap',
    url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '© OpenTopoMap (CC-BY-SA) · © OpenStreetMap',
    dark: false,
    maxZoom: 17,
  },
  {
    id: 'dark',
    label: 'Carto Dark',
    url: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    attribution: '© CARTO · © OpenStreetMap',
    dark: true,
    maxZoom: 20,
  },
  {
    id: 'light',
    label: 'Carto Light',
    url: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    attribution: '© CARTO · © OpenStreetMap',
    dark: false,
    maxZoom: 20,
  },
  {
    id: 'voyager',
    label: 'Carto Voyager',
    url: 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
    attribution: '© CARTO · © OpenStreetMap',
    dark: false,
    maxZoom: 20,
  },
]

export function styleById(id: string): MapStyleDef {
  return MAP_STYLES.find((s) => s.id === id) ?? MAP_STYLES[0]
}
