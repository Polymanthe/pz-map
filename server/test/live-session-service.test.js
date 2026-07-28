import test from "node:test";
import assert from "node:assert/strict";
import { ApplicationError, LiveSessionService } from "../src/application/live-session-service.js";
import { InMemorySessionRepository } from "../src/adapters/outbound/in-memory-session-repository.js";

test("host activity extends expiration and cleanup removes expired sessions", () => {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  let tokenNumber = 0;
  const service = new LiveSessionService({
    repository: new InMemorySessionRepository(),
    ttlMs: 1_000,
    now: () => now,
    randomToken: () => String(++tokenNumber).padStart(32, "A"),
  });

  const created = service.createSession();
  now += 900;
  service.updateCursor({
    sessionId: created.sessionId,
    publisherToken: created.publisherToken,
    position: { x: 1, y: 2, z: 3 },
    sequence: 0,
  });

  now += 900;
  assert.deepEqual(service.expireSessions(), []);
  assert.deepEqual(service.joinSession({ sessionId: created.sessionId }).position, { x: 1, y: 2, z: 3 });

  now += 101;
  assert.throws(
    () => service.joinSession({ sessionId: created.sessionId }),
    (error) => error instanceof ApplicationError && error.code === "SESSION_NOT_FOUND",
  );
  assert.deepEqual(service.expireSessions(), [created.sessionId]);
});

test("limits active session capacity", () => {
  let tokenNumber = 0;
  const service = new LiveSessionService({
    repository: new InMemorySessionRepository(),
    ttlMs: 1_000,
    maxSessions: 1,
    randomToken: () => String(++tokenNumber).padStart(32, "A"),
  });

  service.createSession();
  assert.throws(
    () => service.createSession(),
    (error) => error instanceof ApplicationError && error.code === "CAPACITY_REACHED",
  );
});

test("only the publisher can stop a session", () => {
  let tokenNumber = 0;
  const service = new LiveSessionService({
    repository: new InMemorySessionRepository(),
    ttlMs: 1_000,
    randomToken: () => String(++tokenNumber).padStart(32, "A"),
  });
  const created = service.createSession();

  assert.throws(
    () => service.stopSession({ sessionId: created.sessionId, publisherToken: "Z".repeat(32) }),
    (error) => error instanceof ApplicationError && error.code === "FORBIDDEN",
  );
  assert.equal(service.stopSession({
    sessionId: created.sessionId,
    publisherToken: created.publisherToken,
  }), created.sessionId);
  assert.throws(
    () => service.joinSession({ sessionId: created.sessionId }),
    (error) => error instanceof ApplicationError && error.code === "SESSION_NOT_FOUND",
  );
});
