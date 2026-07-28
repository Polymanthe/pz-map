const MAX_COORDINATE = 1_000_000;
const MAX_Z = 10_000;

export class PositionValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PositionValidationError";
  }
}

export function normalizePosition(value) {
  if (!isPlainObject(value) || !hasExactlyKeys(value, ["x", "y", "z"])) {
    throw new PositionValidationError("Position must contain exactly x, y and z");
  }

  if (!isBoundedFiniteNumber(value.x) || !isBoundedFiniteNumber(value.y)) {
    throw new PositionValidationError("Position x and y must be finite numbers within bounds");
  }

  if (!Number.isSafeInteger(value.z) || Math.abs(value.z) > MAX_Z) {
    throw new PositionValidationError("Position z must be an integer within bounds");
  }

  return Object.freeze({
    x: normalizeZero(value.x),
    y: normalizeZero(value.y),
    z: normalizeZero(value.z),
  });
}

function isBoundedFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
}

function normalizeZero(value) {
  return Object.is(value, -0) ? 0 : value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactlyKeys(value, expectedKeys) {
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}
