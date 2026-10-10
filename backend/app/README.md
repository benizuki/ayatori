# Backend application structure

The backend is grouped by responsibility so API wiring, business logic, and
persistence details can be inspected independently.

```text
backend/app/
├── main.py                  App assembly only: routers, middleware, startup
├── runtime.py               Shared process state: paths, stores, interview records
├── schemas.py               Shared API request/response models
├── api/                     HTTP layer
│   ├── middleware.py        Host/Origin/size checks, auth and roles, AI usage
│   ├── common.py            Request, tenant and org-unit resolution shared by routers
│   └── *_api.py             One router per feature (auth, users, interviews, ...)
├── core/                    Authentication and HTTP security infrastructure
├── services/                Business operations and external AI/audio services
├── storage/                 Runtime persistence adapters
├── resources/               Read-only definitions bundled with the application
└── data/                    Local runtime data (ignored by Git)
```

## Placement rules

- Add HTTP routes to the feature router in `api/` (or a new `api/<feature>_api.py`
  registered in `main.py`). Keep `main.py` free of route handlers.
- Request-wide checks belong in `api/middleware.py`; helpers used by several
  routers belong in `api/common.py`.
- Shared mutable state (stores, data directories) lives in `runtime.py`. Routers
  read it as `runtime.store`, `runtime.SQLITE_BACKUP_DIR`, ... so tests can swap
  it with `patch.object(runtime, ...)`. Do not `from ..runtime import store`.
- Add shared Pydantic contracts to `schemas.py`.
- Put authentication and request-wide security behavior in `core/`.
- Resolve repository-level default paths through `core/paths.py`; do not derive
  them independently from modules that may be moved.
- Put business rules and integrations that do not own persistence in `services/`.
- Put SQLite, JSON, and filesystem access in `storage/`.
- Put bundled JSON definitions and their parsing logic in `resources/`.
- Local runtime files are written below `data/`. Docker overrides this root with
  `/app/data` through `AYATORI_DATA_DIR`.

Keep dependencies directed toward shared schemas and lower-level adapters.
`storage/` and `services/` must not import `main.py` or anything in `api/`.
