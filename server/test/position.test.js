import test from "node:test";
import assert from "node:assert/strict";
import { normalizePosition, PositionValidationError } from "../src/domain/position.js";

test("normalizes a valid position without retaining remote fields", () => {
  assert.deepEqual(normalizePosition({ x: -0, y: 12.5, z: 3 }), { x: 0, y: 12.5, z: 3 });
  assert.throws(
    () => normalizePosition({ x: 1, y: 2, z: 3, html: "<script>" }),
    PositionValidationError,
  );
});

test("rejects non-finite, out-of-bounds and non-integer coordinates", () => {
  assert.throws(() => normalizePosition({ x: Infinity, y: 0, z: 0 }), PositionValidationError);
  assert.throws(() => normalizePosition({ x: 1_000_001, y: 0, z: 0 }), PositionValidationError);
  assert.throws(() => normalizePosition({ x: 0, y: 0, z: 1.5 }), PositionValidationError);
});
