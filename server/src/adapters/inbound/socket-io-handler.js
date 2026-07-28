import { ApplicationError } from "../../application/live-session-service.js";

const CREATE_LIMIT = 5;
const CREATE_WINDOW_MS = 60_000;

export function registerSocketIoHandler(io, service, { now = Date.now, logger = console } = {}) {
  io.on("connection", (socket) => {
    const createTimestamps = [];

    socket.on("session:create", async (ack) => {
      await acknowledge(ack, async () => {
        enforceLimit(createTimestamps, now(), CREATE_LIMIT, CREATE_WINDOW_MS, "Session creation rate exceeded");
        const result = service.createSession();
        await socket.join(result.sessionId);
        return result;
      }, logger);
    });

    socket.on("session:join", async (payload, ack) => {
      await acknowledge(ack, async () => {
        const session = service.joinSession(payload);
        await socket.join(session.id);
        return { session };
      }, logger);
    });

    socket.on("cursor:update", async (payload, ack) => {
      await acknowledge(ack, async () => {
        const event = service.updateCursor(payload);
        socket.to(payload.sessionId).emit("position:changed", event);
        return {};
      }, logger);
    });

    socket.on("session:stop", async (payload, ack) => {
      await acknowledge(ack, async () => {
        const sessionId = service.stopSession(payload);
        io.to(sessionId).emit("session:expired", { sessionId });
        await io.in(sessionId).socketsLeave(sessionId);
        return {};
      }, logger);
    });
  });
}

function enforceLimit(timestamps, timestamp, limit, windowMs, message) {
  while (timestamps.length > 0 && timestamps[0] <= timestamp - windowMs) {
    timestamps.shift();
  }

  if (timestamps.length >= limit) {
    throw new ApplicationError("RATE_LIMITED", message);
  }

  timestamps.push(timestamp);
}

async function acknowledge(ack, action, logger) {
  try {
    const result = await action();
    if (typeof ack === "function") {
      ack({ ok: true, ...result });
    }
  } catch (error) {
    if (typeof ack === "function") {
      ack({ ok: false, error: toPublicError(error) });
    } else if (!(error instanceof ApplicationError)) {
      logger.error(error);
    }
  }
}

function toPublicError(error) {
  if (error instanceof ApplicationError) {
    return { code: error.code, message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: "Internal server error" };
}
