import { imageToPz, isImagePointInside, pzToImage } from './coordinates.js';
import { initLiveSharing } from './live-sharing.js';
import { CATEGORY_LABELS, isValidMarker } from './marker-data.js';

const STORAGE_KEY = 'pz-map-markers-v1';
const PLACES = [
  { name: 'Muldraugh', x: 10600, y: 9700, code: 'MD' },
  { name: 'West Point', x: 11800, y: 6900, code: 'WP' },
  { name: 'Louisville', x: 12300, y: 2600, code: 'LV' },
  { name: 'Rosewood', x: 8100, y: 11700, code: 'RW' },
  { name: 'Riverside', x: 6500, y: 5300, code: 'RS' },
];

const state = {
  manifest: null,
  map: null,
  bounds: null,
  currentFloor: 0,
  tileLayers: new Map(),
  markerLayers: new Map(),
  markers: [],
  pendingMarker: null,
  addingMarker: false,
  remoteCursorLayer: null,
  remoteCursorPosition: null,
};

const elements = {
  addMarker: document.querySelector('#add-marker'),
  coordinateValue: document.querySelector('#coordinate-value'),
  dialog: document.querySelector('#marker-dialog'),
  dialogCoordinates: document.querySelector('#dialog-coordinates'),
  exportMarkers: document.querySelector('#export-markers'),
  floorSelect: document.querySelector('#floor-select'),
  form: document.querySelector('#marker-form'),
  importMarkers: document.querySelector('#import-markers'),
  mapStatus: document.querySelector('#map-status'),
  mapVersion: document.querySelector('#map-version'),
  markerCount: document.querySelector('#marker-count'),
  markerFile: document.querySelector('#marker-file'),
  markerList: document.querySelector('#marker-list'),
  placeList: document.querySelector('#place-list'),
  poiCount: document.querySelector('#poi-count'),
  sidebar: document.querySelector('#sidebar'),
  sidebarClose: document.querySelector('#sidebar-close'),
  sidebarOpen: document.querySelector('#sidebar-open'),
};

function setStatus(message, error = false) {
  elements.mapStatus.textContent = message;
  elements.mapStatus.classList.toggle('is-error', error);
  elements.mapStatus.classList.add('is-visible');
  if (!error) window.setTimeout(() => elements.mapStatus.classList.remove('is-visible'), 1800);
}

function imageToLatLng(point) {
  return state.map.unproject([point.x, point.y], state.manifest.zoom.max);
}

function latLngToImage(latlng) {
  const point = state.map.project(latlng, state.manifest.zoom.max);
  return { x: point.x, y: point.y };
}

function pzToLatLng(x, y, z = state.currentFloor) {
  return imageToLatLng(pzToImage(state.manifest.projection, x, y, z));
}

function coordinatesFromLatLng(latlng, floor = state.currentFloor) {
  const image = latLngToImage(latlng);
  return imageToPz(state.manifest.projection, image.x, image.y, floor);
}

function isPzPositionInside(position) {
  return isImagePointInside(
    state.manifest.extent,
    pzToImage(state.manifest.projection, position.x, position.y, position.z),
  );
}

function remoteCursorIcon() {
  return L.divIcon({
    className: 'live-cursor-wrapper',
    html: '<span class="live-cursor"></span>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function renderRemoteCursor(position = state.remoteCursorPosition) {
  state.remoteCursorPosition = position;
  if (!position || position.z !== state.currentFloor || !isPzPositionInside(position)) {
    state.remoteCursorLayer?.remove();
    state.remoteCursorLayer = null;
    return;
  }

  const latlng = pzToLatLng(position.x, position.y, position.z);
  if (state.remoteCursorLayer) {
    state.remoteCursorLayer.setLatLng(latlng);
  } else {
    state.remoteCursorLayer = L.marker(latlng, {
      icon: remoteCursorIcon(),
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000,
    }).addTo(state.map);
  }
}

function clearRemoteCursor() {
  state.remoteCursorPosition = null;
  state.remoteCursorLayer?.remove();
  state.remoteCursorLayer = null;
}

function updateCoordinateReadout(latlng) {
  const pz = coordinatesFromLatLng(latlng);
  elements.coordinateValue.textContent = `X ${Math.floor(pz.x)} · Y ${Math.floor(pz.y)} · Z ${pz.z}`;
}

function renderPlaces() {
  elements.placeList.replaceChildren();
  let visibleCount = 0;
  for (const place of PLACES) {
    const image = pzToImage(state.manifest.projection, place.x, place.y, 0);
    const isAvailable = isImagePointInside(state.manifest.extent, image);
    const button = document.createElement('button');
    button.className = 'place-button';
    button.disabled = !isAvailable;
    button.innerHTML = `<span class="place-code">${place.code}</span><span>${place.name}</span><small>${place.x}, ${place.y}</small>`;
    if (isAvailable) {
      visibleCount += 1;
      button.addEventListener('click', () => {
        state.map.flyTo(pzToLatLng(place.x, place.y, 0), Math.min(5, state.manifest.zoom.max), { duration: 0.7 });
        closeSidebarOnMobile();
      });
      L.circleMarker(pzToLatLng(place.x, place.y, 0), {
        radius: 5,
        color: '#e4a950',
        fillColor: '#111713',
        fillOpacity: 0.9,
        weight: 2,
      }).bindTooltip(place.name, { direction: 'top' }).addTo(state.map);
    }
    elements.placeList.append(button);
  }
  elements.poiCount.textContent = visibleCount;
}

function loadMarkers() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    state.markers = Array.isArray(saved?.markers) ? saved.markers.filter(isValidMarker) : [];
  } catch {
    state.markers = [];
  }
}

function saveMarkers() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, markers: state.markers }));
}

function markerIcon(category) {
  return L.divIcon({
    className: '',
    html: `<span class="custom-marker custom-marker--${category}"></span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function renderMarkers() {
  for (const layer of state.markerLayers.values()) layer.remove();
  state.markerLayers.clear();
  elements.markerList.replaceChildren();
  const floorMarkers = state.markers.filter((marker) => marker.z === state.currentFloor);
  elements.markerCount.textContent = state.markers.length;

  if (state.markers.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Aucun repère enregistré.';
    elements.markerList.append(empty);
  }

  for (const marker of state.markers) {
    const row = document.createElement('article');
    row.className = 'marker-row';
    const focus = document.createElement('button');
    focus.className = 'marker-focus';
    focus.title = `Centrer sur ${marker.title}`;
    const swatch = document.createElement('span');
    swatch.className = `marker-swatch marker-swatch--${marker.category}`;
    const details = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = marker.title;
    const coordinates = document.createElement('small');
    coordinates.textContent = `${CATEGORY_LABELS[marker.category]} · ${Math.floor(marker.x)}, ${Math.floor(marker.y)}, ${marker.z}`;
    details.append(title, coordinates);
    focus.append(swatch, details);
    focus.addEventListener('click', () => {
      setFloor(marker.z);
      state.map.flyTo(pzToLatLng(marker.x, marker.y, marker.z), Math.min(6, state.manifest.zoom.max));
      closeSidebarOnMobile();
    });
    const remove = document.createElement('button');
    remove.className = 'marker-delete';
    remove.title = `Supprimer ${marker.title}`;
    remove.setAttribute('aria-label', `Supprimer ${marker.title}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      state.markers = state.markers.filter((item) => item.id !== marker.id);
      saveMarkers();
      renderMarkers();
    });
    row.append(focus, remove);
    elements.markerList.append(row);
  }

  for (const marker of floorMarkers) {
    const point = pzToImage(state.manifest.projection, marker.x, marker.y, marker.z);
    if (!isImagePointInside(state.manifest.extent, point)) continue;
    const layer = L.marker(imageToLatLng(point), { icon: markerIcon(marker.category) })
      .bindPopup(`<strong>${escapeHtml(marker.title)}</strong>${marker.notes ? `<p>${escapeHtml(marker.notes)}</p>` : ''}`)
      .addTo(state.map);
    state.markerLayers.set(marker.id, layer);
  }
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

function setFloor(floorId) {
  const floor = state.manifest.floors.find((item) => item.id === Number(floorId));
  if (!floor) return;
  state.currentFloor = floor.id;
  elements.floorSelect.value = String(floor.id);
  for (const layer of state.tileLayers.values()) layer.remove();
  const visibleFloors = state.manifest.floors
    .filter((item) => item.id >= 0 && item.id <= floor.id)
    .sort((a, b) => a.id - b.id);
  for (const item of visibleFloors) state.tileLayers.get(item.id)?.addTo(state.map);
  renderMarkers();
  renderRemoteCursor();
  updateCoordinateReadout(state.map.getCenter());
}

function configureFloors() {
  elements.floorSelect.replaceChildren();
  for (const floor of state.manifest.floors) {
    const option = document.createElement('option');
    option.value = floor.id;
    option.textContent = floor.label;
    elements.floorSelect.append(option);
    state.tileLayers.set(floor.id, L.tileLayer(floor.url, {
      tileSize: state.manifest.tileSize,
      minZoom: state.manifest.zoom.min,
      maxZoom: state.manifest.zoom.max,
      minNativeZoom: state.manifest.zoom.min,
      maxNativeZoom: state.manifest.zoom.max,
      bounds: state.bounds,
      noWrap: true,
      keepBuffer: 2,
      updateWhenIdle: true,
      attribution: 'Rendered with pzmap2dzi',
    }));
  }
  elements.floorSelect.addEventListener('change', (event) => setFloor(Number(event.target.value)));
  setFloor(state.manifest.floors[0].id);
}

function beginMarkerPlacement() {
  state.addingMarker = !state.addingMarker;
  elements.addMarker.classList.toggle('is-active', state.addingMarker);
  elements.addMarker.textContent = state.addingMarker ? 'Cliquez sur la carte' : 'Ajouter';
  document.body.classList.toggle('placing-marker', state.addingMarker);
  if (state.addingMarker) {
    setStatus('Sélectionnez un emplacement sur la carte');
    closeSidebarOnMobile();
  }
}

function openMarkerDialog(latlng) {
  const pz = coordinatesFromLatLng(latlng);
  state.pendingMarker = { x: pz.x, y: pz.y, z: pz.z };
  elements.dialogCoordinates.textContent = `X ${Math.floor(pz.x)} · Y ${Math.floor(pz.y)} · Z ${pz.z}`;
  elements.form.reset();
  elements.dialog.showModal();
  elements.form.elements.title.focus();
}

function saveMarkerFromDialog() {
  if (!state.pendingMarker || !elements.form.reportValidity()) return;
  const data = new FormData(elements.form);
  state.markers.push({
    id: crypto.randomUUID(),
    title: String(data.get('title')).trim(),
    category: String(data.get('category')),
    notes: String(data.get('notes')).trim(),
    ...state.pendingMarker,
    createdAt: new Date().toISOString(),
  });
  state.pendingMarker = null;
  saveMarkers();
  renderMarkers();
  setStatus('Marqueur enregistré');
}

function exportMarkers() {
  const content = JSON.stringify({ version: 1, markers: state.markers }, null, 2);
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `pz-markers-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importMarkers(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data?.version !== 1 || !Array.isArray(data.markers) || !data.markers.every(isValidMarker)) {
      throw new Error('Format de marqueurs non reconnu');
    }
    const merged = new Map(state.markers.map((marker) => [marker.id, marker]));
    for (const marker of data.markers) merged.set(marker.id, marker);
    state.markers = [...merged.values()];
    saveMarkers();
    renderMarkers();
    setStatus(`${data.markers.length} marqueur(s) importé(s)`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    elements.markerFile.value = '';
  }
}

function closeSidebarOnMobile() {
  if (window.matchMedia('(max-width: 760px)').matches) elements.sidebar.classList.remove('is-open');
}

function wireInteractions() {
  state.map.on('mousemove', (event) => updateCoordinateReadout(event.latlng));
  state.map.on('move', () => {
    if (window.matchMedia('(pointer: coarse)').matches) updateCoordinateReadout(state.map.getCenter());
  });
  state.map.on('click', (event) => {
    if (!state.addingMarker) return;
    beginMarkerPlacement();
    openMarkerDialog(event.latlng);
  });
  elements.addMarker.addEventListener('click', beginMarkerPlacement);
  elements.exportMarkers.addEventListener('click', exportMarkers);
  elements.importMarkers.addEventListener('click', () => elements.markerFile.click());
  elements.markerFile.addEventListener('change', () => {
    if (elements.markerFile.files[0]) importMarkers(elements.markerFile.files[0]);
  });
  elements.form.addEventListener('submit', (event) => {
    if (event.submitter?.value !== 'save') return;
    event.preventDefault();
    saveMarkerFromDialog();
    elements.dialog.close();
  });
  elements.sidebarOpen.addEventListener('click', () => elements.sidebar.classList.add('is-open'));
  elements.sidebarClose.addEventListener('click', () => elements.sidebar.classList.remove('is-open'));
}

async function bootstrap() {
  try {
    const response = await fetch('/map-manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Manifeste indisponible (${response.status})`);
    state.manifest = await response.json();
    state.currentFloor = state.manifest.floors[0].id;
    state.map = L.map('map', {
      crs: L.CRS.Simple,
      minZoom: state.manifest.zoom.min,
      maxZoom: state.manifest.zoom.max,
      maxBoundsViscosity: 1,
      zoomControl: false,
      attributionControl: true,
    });
    const southWest = state.map.unproject([0, state.manifest.extent.height], state.manifest.zoom.max);
    const northEast = state.map.unproject([state.manifest.extent.width, 0], state.manifest.zoom.max);
    state.bounds = L.latLngBounds(southWest, northEast);
    state.map.setMaxBounds(state.bounds.pad(0.04));
    state.map.fitBounds(state.bounds, { animate: false });
    L.control.zoom({ position: 'bottomright' }).addTo(state.map);

    elements.mapVersion.textContent = `${state.manifest.pzVersion} · ${state.manifest.buildId}`;
    configureFloors();
    renderPlaces();
    loadMarkers();
    renderMarkers();
    wireInteractions();
    initLiveSharing({
      onPointerMove(handler) {
        state.map.on('mousemove', (event) => handler(coordinatesFromLatLng(event.latlng)));
      },
      isPositionInside: isPzPositionInside,
      showRemoteCursor: renderRemoteCursor,
      clearRemoteCursor,
    });
    updateCoordinateReadout(state.map.getCenter());
    setStatus('Carte opérationnelle');
  } catch (error) {
    setStatus(error.message, true);
    console.error(error);
  }
}

bootstrap();
