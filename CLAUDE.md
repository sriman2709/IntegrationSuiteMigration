# IntegrationSuiteMigration — SAP Integration Suite Migration Assessment Tool

## What This Is
Sierra Digital's consulting tool for assessing integration platforms (Boomi, SAP PI/PO, TIBCO, MuleSoft) and generating migration assessment reports for converting to SAP Integration Suite iFlows.

## Tech Stack
- **Backend:** Node.js + Express.js
- **Database:** PostgreSQL (`integration_migration` DB, port 5432)
- **Frontend:** SPA — `/public/index.html` (single-file, all CSS+JS inline)
- **Port:** 4001 (4000 is used by HANACloudMigration)

## Run Locally
```bash
npm install
# Requires PostgreSQL running with integration_migration database
createdb integration_migration   # if not exists
node database/seed.js            # load sample data (optional)
node server.js                   # serves on port 4001
```

## Environment Variables (`.env`)
```
PORT=4001
DATABASE_URL=postgresql://localhost:5432/integration_migration
BOOMI_API_BASE=https://api.boomi.com/api/rest/v1
```

## Project Structure
```
IntegrationSuiteMigration/
├── server.js              — Express app entry point
├── database/
│   ├── db.js              — Pool + schema init (6 tables)
│   └── seed.js            — 4 sample projects, 90+ artifacts
├── routes/
│   ├── projects.js        — CRUD for migration projects
│   ├── sources.js         — Source connections + file upload + Boomi API sync
│   ├── artifacts.js       — Process artifacts CRUD + assess/convert/qa/deploy/validate
│   ├── analysis.js        — Complexity scoring + project analysis reports
│   └── seed.js            — POST /api/seed endpoint
├── parsers/
│   ├── boomi.js           — Parse Boomi component XML
│   ├── pipo.js            — Parse SAP PI/PO XI export XML
│   ├── tibco.js           — Parse TIBCO BW process XML
│   └── mulesoft.js        — Parse MuleSoft mule-config XML
├── samples/               — Sample XML files for each platform
└── public/index.html      — Complete SPA frontend
```

## API Routes
- `GET/POST /api/projects` — List / create projects
- `GET/PUT/DELETE /api/projects/:id` — Single project CRUD
- `GET /api/sources/project/:projectId` — Sources for project
- `POST /api/sources` — Create connection
- `POST /api/sources/:id/sync` — Trigger sync (API or file)
- `POST /api/sources/upload` — Upload ZIP/XML file
- `GET /api/artifacts/project/:projectId` — List artifacts with filters
- `POST /api/artifacts/:id/assess` — Generate assessment
- `POST /api/artifacts/:id/convert` — Start conversion
- `POST /api/artifacts/:id/qa` — Run QA check
- `POST /api/artifacts/:id/deploy` — Deploy
- `POST /api/artifacts/:id/validate` — Validate
- `GET /api/analysis/project/:id` — Full project analysis report
- `POST /api/seed` — Load seed data

## Supported Platforms
- **Boomi** — AtomSphere component XML / REST API
- **PIPO/SAP PI** — XI export format (IntegrationRepository XML)
- **TIBCO** — BusinessWorks process XML
- **MuleSoft** — Mule configuration XML

## Complexity Scoring
0–100 point weighted formula:
- Shapes (×1.5) — process step count
- Connectors (×2.0) — adapter count
- Maps (×2.5) — mapping complexity
- Scripting (×2.0) — Groovy/DataWeave usage
- Error Handling (×1.0) — try/catch depth
- Dependencies (×1.0) — sub-process count

Levels: Simple (≤34), Medium (35–64), Complex (65+)
T-Shirt: XS/S/M/L/XL → Effort: 1/2/5/12/18 days
