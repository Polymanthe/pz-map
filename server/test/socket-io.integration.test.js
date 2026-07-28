import test from "node:test";
import assert from "node:assert/strict";
import { io as createClient } from "socket.io-client";
import { createLiveServer } from "../src/index.js";

async function withServer(run, options = {}) {
  const server = createLiveServer({ ttlMs: 60_000, cleanupIntervalMs: 60_000, ...options });
  const address = await server.listen(0);
  const clients = [];

  const connect = async (options = {}) => {
    const client = createClient(`http://127.0.0.1:${address.port}`, {
      transports: ["websocket"],
      forceNew: true,
      ...options,
    });
    clients.push(client);
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    });
    return client;
  };

  try {
    await run({ connect, port: address.port });
  } finally {
    for (const client of clients) client.disconnect();
    await server.close();
  }
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No acknowledgement for ${event}`)), 1_000);
    const ack = (response) => {
      clearTimeout(timeout);
      resolve(response);
    };

    if (payload === undefined) socket.emit(event, ack);
    else socket.emit(event, payload, ack);
  });
}

test("creates a session and serves health and browser client endpoints", async () => {
  await withServer(async ({ connect, port }) => {
    const host = await connect();
    const created = await emitAck(host, "session:create");

    assert.equal(created.ok, true);
    assert.match(created.sessionId, /^[A-Za-z0-9_-]{32}$/);
    assert.match(created.publisherToken, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(typeof created.expiresAt, "string");

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const browserClient = await fetch(`http://127.0.0.1:${port}/socket.io/socket.io.js`);
    assert.equal(browserClient.status, 200);
  });
});

test("retains the latest position for a late reader", async () => {
  await withServer(async ({ connect }) => {
    const host = await connect();
    const created = await emitAck(host, "session:create");
    const updated = await emitAck(host, "cursor:update", {
      sessionId: created.sessionId,
      publisherToken: created.publisherToken,
      position: { x: 10.5, y: -4, z: 2 },
      sequence: 7,
    });
    assert.deepEqual(updated, { ok: true });

    const reader = await connect();
    const joined = await emitAck(reader, "session:join", { sessionId: created.sessionId });
    assert.equal(joined.ok, true);
    assert.deepEqual(joined.session.position, { x: 10.5, y: -4, z: 2 });
  });
});

test("broadcasts cursor updates to other sockets in the room", async () => {
  await withServer(async ({ connect }) => {
    const host = await connect();
    const reader = await connect();
    const created = await emitAck(host, "session:create");
    await emitAck(reader, "session:join", { sessionId: created.sessionId });

    const changed = new Promise((resolve) => reader.once("position:changed", resolve));
    await emitAck(host, "cursor:update", {
      sessionId: created.sessionId,
      publisherToken: created.publisherToken,
      position: { x: 1, y: 2, z: 3 },
      sequence: 9,
    });

    const event = await changed;
    assert.deepEqual(event, {
      source: { id: "host", type: "cursor" },
      position: { x: 1, y: 2, z: 3 },
      sequence: 9,
      observedAt: event.observedAt,
    });
    assert.equal(Number.isNaN(Date.parse(event.observedAt)), false);
  });
});

test("refuses a reader with a bad publisher token", async () => {
  await withServer(async ({ connect }) => {
    const host = await connect();
    const reader = await connect();
    const created = await emitAck(host, "session:create");
    await emitAck(reader, "session:join", { sessionId: created.sessionId });

    const response = await emitAck(reader, "cursor:update", {
      sessionId: created.sessionId,
      publisherToken: "A".repeat(32),
      position: { x: 1, y: 2, z: 3 },
      sequence: 0,
    });
    assert.deepEqual(response, {
      ok: false,
      error: { code: "FORBIDDEN", message: "Publisher token is invalid" },
    });
    assert.equal("stack" in response.error, false);
  });
});

test("rejects malformed payloads and limits updates per socket", async () => {
  await withServer(async ({ connect }) => {
    const host = await connect();
    const created = await emitAck(host, "session:create");

    const invalid = await emitAck(host, "cursor:update", {
      sessionId: created.sessionId,
      publisherToken: created.publisherToken,
      position: { x: "<script>", y: 2, z: 3 },
      sequence: 0,
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, "INVALID_PAYLOAD");

    const responses = [];
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      responses.push(await emitAck(host, "cursor:update", {
        sessionId: created.sessionId,
        publisherToken: created.publisherToken,
        position: { x: sequence, y: 2, z: 3 },
        sequence,
      }));
    }
    assert.equal(responses.filter((response) => response.ok).length, 20);
    const limited = await emitAck(host, "cursor:update", {
      sessionId: created.sessionId,
      publisherToken: created.publisherToken,
      position: { x: 21, y: 2, z: 3 },
      sequence: 21,
    });
    assert.equal(limited.error.code, "RATE_LIMITED");
  });
});

test("rejects browser connections from an untrusted origin", async () => {
  await withServer(async ({ port }) => {
    const client = createClient(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      forceNew: true,
      extraHeaders: { Origin: "https://untrusted.example" },
      reconnection: false,
    });
    await assert.rejects(new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    }));
    client.disconnect();
  });
});

test("notifies room members when cleanup expires a session", async () => {
  await withServer(async ({ connect }) => {
    const host = await connect();
    const created = await emitAck(host, "session:create");
    const expired = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Session did not expire")), 500);
      host.once("session:expired", (event) => {
        clearTimeout(timeout);
        resolve(event);
      });
    });

    assert.deepEqual(await expired, { sessionId: created.sessionId });
    const joined = await emitAck(host, "session:join", { sessionId: created.sessionId });
    assert.equal(joined.ok, false);
    assert.equal(joined.error.code, "SESSION_NOT_FOUND");
  }, { ttlMs: 30, cleanupIntervalMs: 5 });
});

test("stops a session and notifies its readers", async () => {
  await withServer(async ({ connect }) => {
    const host = await connect();
    const reader = await connect();
    const created = await emitAck(host, "session:create");
    await emitAck(reader, "session:join", { sessionId: created.sessionId });
    const expired = new Promise((resolve) => reader.once("session:expired", resolve));

    const stopped = await emitAck(host, "session:stop", {
      sessionId: created.sessionId,
      publisherToken: created.publisherToken,
    });

    assert.deepEqual(stopped, { ok: true });
    assert.deepEqual(await expired, { sessionId: created.sessionId });
    const joined = await emitAck(reader, "session:join", { sessionId: created.sessionId });
    assert.equal(joined.error.code, "SESSION_NOT_FOUND");
  });
});
