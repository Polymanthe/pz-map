import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLiveReaderUrl,
  isValidPositionChanged,
  parseLiveSessionId,
} from '../public/live-sharing.js';

const SESSION_ID = 'A'.repeat(32);

test('parses a live session from the URL fragment', () => {
  assert.equal(parseLiveSessionId(`#live=${SESSION_ID}`), SESSION_ID);
  assert.equal(parseLiveSessionId(`#view=map&live=${SESSION_ID}`), SESSION_ID);
});

test('rejects absent, empty, duplicate, or whitespace session ids', () => {
  assert.equal(parseLiveSessionId(''), null);
  assert.equal(parseLiveSessionId('#live='), null);
  assert.equal(parseLiveSessionId('#live=one&live=two'), null);
  assert.equal(parseLiveSessionId('#live=with+spaces'), null);
});

test('builds a same-origin reader URL without preserving another fragment', () => {
  const result = buildLiveReaderUrl('https://map.example.test/view?lang=fr#old', SESSION_ID);
  const url = new URL(result);

  assert.equal(url.origin, 'https://map.example.test');
  assert.equal(url.pathname, '/view');
  assert.equal(url.search, '?lang=fr');
  assert.equal(parseLiveSessionId(url.hash), SESSION_ID);
  assert.equal(result.includes('publisherToken'), false);
});

test('validates position:changed payloads from the host cursor', () => {
  const payload = {
    source: { id: 'host', type: 'cursor' },
    position: { x: 10642.5, y: 9731.25, z: 0 },
    sequence: 12,
    observedAt: '2026-07-28T10:00:00.000Z',
  };

  assert.equal(isValidPositionChanged(payload), true);
  assert.equal(isValidPositionChanged({ ...payload, sequence: -1 }), false);
  assert.equal(isValidPositionChanged({ ...payload, position: { ...payload.position, x: NaN } }), false);
  assert.equal(isValidPositionChanged({ ...payload, source: { id: 'reader', type: 'cursor' } }), false);
  assert.equal(isValidPositionChanged({ ...payload, observedAt: 'not-a-date' }), false);
});
