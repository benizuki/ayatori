# Initial data

This directory contains the default master and sample data shipped with
Ayatori. `backend.app.resources.initial_data` loads these files and exposes them through
`GET /api/initial-data`.

- `departments.json`: initial department IDs and departments
- `interview-topic-templates.json`: shared interview topics applied to every business
- `business-process-masters.json`: sample business process masters (two per department)
- `interview-messages.json`: sample interview conversation
- `process-steps.json`: sample As-Is process steps
- `work-fragments.json`: sample work fragments extracted from interviews

At runtime, `MasterDataStore` creates one writable JSON master file per tenant
under `AYATORI_MASTER_DATA_DIR`. The runtime directory must be mounted when
Ayatori runs in Docker. Department and business-master changes are written back
to that same tenant master file; they are not duplicated in the operational store.

When upgrading from the earlier single-store layout, the first app-state read
copies any tenant-specific departments and business masters into the tenant JSON
file before removing their duplicate fields from the operational store.

Each sample business master has a realistic As-Is flow in
`backend/app/resources/sample_processes.py`. `GET /api/app-state` returns those
flows to a tenant that has never saved its app state; the first save makes them
that tenant's own data.

Interview guides used to be a separate master. Guided interviews now pick their
target from the business master, so the first read of a tenant file that still
holds `guideTemplates` adopts each guide as a draft business master and drops the
key.
