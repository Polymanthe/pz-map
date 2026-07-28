import { randomBytes, timingSafeEqual } from "node:crypto";
import { normalizePosition, PositionValidationError } from "../domain/position.js";

const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const DEFAULT_UPDATE_LIMIT = 20;
const DEFAULT_UPDATE_WINDOW_MS = 1_000;

export class ApplicationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
  }
}

export class LiveSessionService {
  constructor({
    repository,
    ttlMs,
    maxSessions = 1_000,
    updateLimit = DEFAULT_UPDATE_LIMIT,
    updateWindowMs = DEFAULT_UPDATE_WINDOW_MS,
    now = Date.now,
    randomToken = createRandomToken,
  }) {
    if (!repository || !Number.isSafeInteger(ttlMs) || ttlMs <= 0
      || !Number.isSafeInteger(maxSessions) || maxSessions <= 0
      || !Number.isSafeInteger(updateLimit) || updateLimit <= 0
      || !Number.isSafeInteger(updateWindowMs) || updateWindowMs <= 0) {
      throw new TypeError("Repository limits and TTL must be positive integers");
    }

    this.repository = repository;
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this.updateLimit = updateLimit;
    this.updateWindowMs = updateWindowMs;
    this.now = now;
    this.randomToken = randomToken;
    this.updateTimestamps = new Map();
  }

  createSession() {
    if (this.repository.count() >= this.maxSessions) {
      throw new ApplicationError("CAPACITY_REACHED", "Session capacity has been reached");
    }
    const timestamp = this.now();
    let id;

    do {
      id = this.randomToken();
    } while (this.repository.findById(id));

    const session = {
      id,
      publisherToken: this.randomToken(),
      position: null,
      expiresAt: timestamp + this.ttlMs,
    };

    this.repository.create(session);

    return {
      sessionId: session.id,
      publisherToken: session.publisherToken,
      expiresAt: toIsoString(session.expiresAt),
    };
  }

  joinSession(payload) {
    assertExactObject(payload, ["sessionId"]);
    assertCredential(payload.sessionId, "session ID");

    const session = this.getActiveSession(payload.sessionId);
    return toPublicSession(session);
  }

  updateCursor(payload) {
    assertExactObject(payload, ["position", "publisherToken", "sequence", "sessionId"]);
    assertCredential(payload.sessionId, "session ID");
    assertCredential(payload.publisherToken, "publisher token");

    if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 0) {
      throw new ApplicationError("INVALID_PAYLOAD", "Sequence must be a non-negative integer");
    }

    let position;
    try {
      position = normalizePosition(payload.position);
    } catch (error) {
      if (error instanceof PositionValidationError) {
        throw new ApplicationError("INVALID_PAYLOAD", error.message);
      }
      throw error;
    }

    const observedAt = this.now();
    const session = this.getActiveSession(payload.sessionId, observedAt);

    if (!safeTokenEquals(payload.publisherToken, session.publisherToken)) {
      throw new ApplicationError("FORBIDDEN", "Publisher token is invalid");
    }
    this.enforceUpdateLimit(session.id, observedAt);

    session.position = position;
    session.expiresAt = observedAt + this.ttlMs;
    this.repository.update(session);

    return {
      source: { id: "host", type: "cursor" },
      position,
      sequence: payload.sequence,
      observedAt: toIsoString(observedAt),
    };
  }

  stopSession(payload) {
    assertExactObject(payload, ["publisherToken", "sessionId"]);
    assertCredential(payload.sessionId, "session ID");
    assertCredential(payload.publisherToken, "publisher token");

    const session = this.getActiveSession(payload.sessionId);
    if (!safeTokenEquals(payload.publisherToken, session.publisherToken)) {
      throw new ApplicationError("FORBIDDEN", "Publisher token is invalid");
    }

    this.repository.deleteById(session.id);
    this.updateTimestamps.delete(session.id);
    return session.id;
  }

  expireSessions() {
    const expiredIds = this.repository.deleteExpired(this.now());
    for (const id of expiredIds) this.updateTimestamps.delete(id);
    return expiredIds;
  }

  getActiveSession(id, timestamp = this.now()) {
    const session = this.repository.findById(id);
    if (!session || session.expiresAt <= timestamp) {
      throw new ApplicationError("SESSION_NOT_FOUND", "Session does not exist or has expired");
    }
    return session;
  }

  enforceUpdateLimit(sessionId, timestamp) {
    const timestamps = this.updateTimestamps.get(sessionId) ?? [];
    while (timestamps.length > 0 && timestamps[0] <= timestamp - this.updateWindowMs) {
      timestamps.shift();
    }
    if (timestamps.length >= this.updateLimit) {
      throw new ApplicationError("RATE_LIMITED", "Cursor update rate exceeded");
    }
    timestamps.push(timestamp);
    this.updateTimestamps.set(sessionId, timestamps);
  }
}

function createRandomToken() {
  return randomBytes(24).toString("base64url");
}

function safeTokenEquals(received, expected) {
  const receivedBuffer = Buffer.from(received, "ascii");
  const expectedBuffer = Buffer.from(expected, "ascii");
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

function assertCredential(value, name) {
  if (typeof value !== "string" || !CREDENTIAL_PATTERN.test(value)) {
    throw new ApplicationError("INVALID_PAYLOAD", `Invalid ${name}`);
  }
}

function assertExactObject(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApplicationError("INVALID_PAYLOAD", "Payload must be an object");
  }

  const keys = Object.keys(value).sort();
  if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])) {
    throw new ApplicationError("INVALID_PAYLOAD", "Payload contains missing or unexpected fields");
  }
}

function toPublicSession(session) {
  return {
    id: session.id,
    position: session.position,
    expiresAt: toIsoString(session.expiresAt),
  };
}

function toIsoString(timestamp) {
  return new Date(timestamp).toISOString();
}
