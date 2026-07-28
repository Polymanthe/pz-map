import assert from 'node:assert/strict';
import test from 'node:test';

import { isValidMarker } from '../public/marker-data.js';

const marker = {
  id: 'marker-1',
  title: 'Safehouse',
  category: 'safehouse',
  notes: '',
  x: 6500,
  y: 5300,
  z: 0,
};

test('accepts marker data produced by the application', () => {
  assert.equal(isValidMarker(marker), true);
  assert.equal(isValidMarker({ ...marker, notes: undefined }), true);
});

test('rejects untrusted marker fields used by the UI', () => {
  assert.equal(isValidMarker({ ...marker, category: 'safehouse\" onclick=\"alert(1)' }), false);
  assert.equal(isValidMarker({ ...marker, title: '' }), false);
  assert.equal(isValidMarker({ ...marker, notes: '<script>'.repeat(100) }), false);
  assert.equal(isValidMarker({ ...marker, x: Number.NaN }), false);
});
