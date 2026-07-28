export class InMemorySessionRepository {
  constructor() {
    this.sessions = new Map();
  }

  create(session) {
    if (this.sessions.has(session.id)) {
      throw new Error("Session already exists");
    }
    this.sessions.set(session.id, session);
  }

  findById(id) {
    return this.sessions.get(id) ?? null;
  }

  update(session) {
    if (!this.sessions.has(session.id)) {
      throw new Error("Session does not exist");
    }
    this.sessions.set(session.id, session);
  }

  deleteById(id) {
    return this.sessions.delete(id);
  }

  deleteExpired(timestamp) {
    const expiredIds = [];
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= timestamp) {
        this.sessions.delete(id);
        expiredIds.push(id);
      }
    }
    return expiredIds;
  }

  count() {
    return this.sessions.size;
  }
}
