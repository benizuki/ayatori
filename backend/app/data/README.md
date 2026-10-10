# Local runtime data

Local backend runs store mutable application data in this directory.
Its contents are ignored by Git.

```text
backend/app/data/
├── auth/
│   ├── tenant_master.json
│   └── user_master.json
├── master-data/
├── ayatori.sqlite
├── interview-sessions.json
└── interview-attachments/
```

Docker sets `AYATORI_DATA_DIR=/app/data` and mounts the persistent disk at that
location. Individual `AYATORI_*` path variables can still override a specific
file or directory.
