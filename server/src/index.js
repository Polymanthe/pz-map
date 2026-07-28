import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Server as SocketIoServer } from "socket.io";
import { LiveSessionService } from "./application/live-session-service.js";
import { registerSocketIoHandler } from "./adapters/inbound/socket-io-handler.js";
import { InMemorySessionRepository } from "./adapters/outbound/in-memory-session-repository.js";

const DEFAULT_PORT = 3000;
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_MAX_SESSIONS = 1_000;
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://[::1]:8080",
];

export function createLiveServer(options = {}) {
  const ttlMs = options.ttlMs ?? readPositiveInteger("SESSION_TTL_MS", DEFAULT_SESSION_TTL_MS);
  const cleanupIntervalMs = options.cleanupIntervalMs
    ?? readPositiveInteger("SESSION_CLEANUP_INTERVAL_MS", DEFAULT_CLEANUP_INTERVAL_MS);
  const repository = options.repository ?? new InMemorySessionRepository();
  const maxSessions = options.maxSessions ?? readPositiveInteger("MAX_SESSIONS", DEFAULT_MAX_SESSIONS);
  const allowedOrigins = options.allowedOrigins ?? readAllowedOrigins();
  const service = options.service ?? new LiveSessionService({ repository, ttlMs, maxSessions });

  const httpServer = createHttpServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end('{"ok":true}');
      return;
    }

    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end('{"error":"not_found"}');
  });

  const io = new SocketIoServer(httpServer, {
    path: "/socket.io/",
    serveClient: true,
    allowRequest(request, callback) {
      const origin = request.headers.origin;
      callback(null, origin === undefined || allowedOrigins.has(origin));
    },
  });
  registerSocketIoHandler(io, service);

  const cleanupTimer = setInterval(() => {
    for (const sessionId of service.expireSessions()) {
      io.to(sessionId).emit("session:expired", { sessionId });
      io.in(sessionId).socketsLeave(sessionId);
    }
  }, cleanupIntervalMs);
  cleanupTimer.unref();

  let closing;
  return {
    httpServer,
    io,
    service,
    listen(port = options.port ?? readPort()) {
      return new Promise((resolveListen, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, () => {
          httpServer.off("error", reject);
          resolveListen(httpServer.address());
        });
      });
    },
    close() {
      if (!closing) {
        clearInterval(cleanupTimer);
        closing = new Promise((resolveClose) => io.close(resolveClose));
      }
      return closing;
    },
  };
}

function readPort() {
  const value = process.env.PORT;
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function readPositiveInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function readAllowedOrigins() {
  const configured = process.env.ALLOWED_ORIGINS;
  const values = configured === undefined ? DEFAULT_ALLOWED_ORIGINS : configured.split(",");
  return new Set(values.map((value) => value.trim()).filter(Boolean));
}

async function main() {
  const server = createLiveServer();
  const address = await server.listen();
  console.log(`pz-map server listening on port ${address.port}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.close();
  };

  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Server startup failed");
    process.exitCode = 1;
  });
}
