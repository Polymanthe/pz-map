# Repository Guidelines

## Scope

This repository contains three independent projects and local Docker Compose
orchestration:

- `webui/`: static Leaflet application served by Nginx;
- `server/`: Node.js Socket.IO service for ephemeral live sessions;
- `pipeline/`: Project Zomboid rendering and tile normalization tools;
- `dist/`: generated data only; never commit files from this directory.

Do not scan the user's home directory. Access files outside this repository only
through an explicit path supplied by the user or through the configured
`PZ_ROOT` game-assets directory.

## Design Principles

- Prefer the smallest correct change.
- Apply KISS and YAGNI before introducing abstractions or dependencies.
- Keep domain and application logic independent from transport and storage.
- Add a port or adapter only when there is a concrete second implementation or
  a boundary that requires isolation.
- Preserve the server's current hexagonal dependency direction:
  `domain <- application <- adapters <- composition root`.
- Keep the web interface framework-free unless a demonstrated requirement makes
  a framework simpler than the existing modules.
- Keep pipeline operations explicit and resumable. Never reintroduce independent
  source-cell render batches while native DZI levels are omitted.

## Generated Data

- All generated maps, renders, logs, caches, and spike outputs belong below
  `dist/`.
- `dist/map/` is the map currently served by Nginx.
- `dist/pipeline/render/` contains resumable renderer state.
- Never point the normalizer at the repository root or at a source directory.
- Do not delete or move an active renderer output. Check running processes and
  containers before reorganizing generated data.
- Do not commit Project Zomboid assets or generated tiles.

## Real-Time Invariants

- A live session has one publisher and any number of readers.
- Reader links contain only the session ID.
- Publisher tokens stay in `sessionStorage`; never place them in URLs, logs, or
  persistent browser storage.
- Validate all remote payloads at the server boundary and before rendering.
- Keep cursor updates disposable and rate-limited; stale positions should not be
  queued.
- Session stop and expiration must remove server state and notify room members.
- Update `ALLOWED_ORIGINS` when adding a deployment hostname.

## Roadmap Issues

- Roadmap issues must be vertical product increments that deliver observable
  user value and can be demonstrated end to end in the WebUI or in Project
  Zomboid.
- Every feature issue must describe the user outcome, the playable or in-game
  validation scenario, and objective acceptance criteria.
- Keep architecture, tests, adapters, and refactors as implementation checklist
  items inside the vertical issue. Create a separate technical issue only when
  it has independently testable value or is a time-boxed spike that resolves a
  documented uncertainty.
- Use milestones and Project fields to group work; do not create epics that are
  only containers for technical tasks.

## Commands

Run all relevant checks before publishing changes:

```bash
npm --prefix webui test
npm --prefix server test
python3 -m unittest discover -s pipeline/tests
bash -n pipeline/scripts/build_tiles.sh
shellcheck pipeline/scripts/build_tiles.sh pipeline/scripts/spike_render.sh
docker compose config --quiet
docker compose up -d --build web
docker compose exec -T web nginx -t
```

Use `npm ci` rather than `npm install` when reproducing lockfile state. A full
map render is intentionally excluded from routine tests.

## Documentation

- Keep root documentation focused on repository-wide setup and workflows.
- Keep project-specific implementation details inside the owning project.
- Update commands and paths whenever files move.
- Document only supported behavior; remove obsolete compatibility options rather
  than retaining dead flags.
