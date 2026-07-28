export const CATEGORY_LABELS = Object.freeze({
  base: 'Base',
  safehouse: 'Safehouse',
  loot: 'Loot',
  danger: 'Danger',
});

export function isValidMarker(marker) {
  return marker
    && typeof marker.id === 'string'
    && marker.id.length <= 100
    && typeof marker.title === 'string'
    && marker.title.length > 0
    && marker.title.length <= 80
    && Object.hasOwn(CATEGORY_LABELS, marker.category)
    && (marker.notes === undefined || (typeof marker.notes === 'string' && marker.notes.length <= 500))
    && Number.isFinite(marker.x)
    && Number.isFinite(marker.y)
    && Number.isInteger(marker.z);
}
