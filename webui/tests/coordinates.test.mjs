import assert from 'node:assert/strict';
import test from 'node:test';

import { imageToPz, isImagePointInside, pzToImage } from '../public/coordinates.js';

const projection = {
  x0: -36864,
  y0: -639008,
  squareSize: 128,
  scale: 1,
};

test('isometric coordinates round-trip on floor zero', () => {
  const source = { x: 10642.25, y: 9731.75, z: 0 };
  const image = pzToImage(projection, source.x, source.y, source.z);
  const result = imageToPz(projection, image.x, image.y, source.z);

  assert.ok(Math.abs(result.x - source.x) < 1e-9);
  assert.ok(Math.abs(result.y - source.y) < 1e-9);
  assert.equal(result.z, source.z);
});

test('floor offset is included in both projection directions', () => {
  const source = { x: 10600, y: 9700, z: 3 };
  const image = pzToImage(projection, source.x, source.y, source.z);
  const result = imageToPz(projection, image.x, image.y, source.z);

  assert.ok(Math.abs(result.x - source.x) < 1e-9);
  assert.ok(Math.abs(result.y - source.y) < 1e-9);
});

test('projection scale supports discarded native zoom levels', () => {
  const scaledProjection = { ...projection, scale: 64 };
  const source = { x: 10600, y: 9700, z: 0 };
  const image = pzToImage(scaledProjection, source.x, source.y, source.z);
  const result = imageToPz(scaledProjection, image.x, image.y, source.z);

  assert.ok(Math.abs(result.x - source.x) < 1e-9);
  assert.ok(Math.abs(result.y - source.y) < 1e-9);
});

test('image extent excludes points on the outer edge', () => {
  const extent = { width: 40064, height: 23392 };
  assert.equal(isImagePointInside(extent, { x: 0, y: 0 }), true);
  assert.equal(isImagePointInside(extent, { x: extent.width, y: 4 }), false);
  assert.equal(isImagePointInside(extent, { x: -1, y: 4 }), false);
});
