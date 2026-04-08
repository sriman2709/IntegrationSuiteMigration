# IntegrationSuiteMigration — SAP Integration Suite Migration Assessment Tool

## What This Is
Sierra Digital's customer-facing consulting demo tool for assessing integration platforms (Boomi, SAP PI/PO, TIBCO, MuleSoft) and generating migration assessment reports for converting to SAP Integration Suite iFlows.

## Tech Stack
- **Backend:** Node.js + Express.js
- **Database:** PostgreSQL (`integration_migration` DB, port 5432)
- **Frontend:** SPA — `/public/index.html` (single-file, all CSS+JS inline — NO React, NO build step)
- **Port:** 4001 locally / 8080 on Azure (App Service sets PORT=8080)
- **Uploads:** multer (ZIP/XML artifacts)
- **Parsing:** xml2js + adm-zip; platform-specific parsers in `/parsers/`

## Run Locally
```bash
npm install
createdb integration_migration   # if not exists
node database/seed.js            # load sample data (optional — auto-seeds on first boot)
node server.js                   # serves on http://localhost:4001
```

## Environment Variables (`.env`)
```
PORT=4001
DATABASE_URL=postgresql://localhost:5432/integration_migration
BOOMI_API_BASE=https://api.boomi.com/api/rest/v1
```

## Azure Deployment (Production)
| Resource | Name | Region |
|----------|------|--------|
| App Service | `is-migration-sd` | Central US |
| App Service Plan | `asp-is-migration` (B1 Linux) | Central US |
| Resource Group | `rg-hana-migration` | — |
| PostgreSQL Server | `cop-postgres-srv` | Central US (COP-Platform RG) |
| Database | `integration_migration` | on cop-postgres-srv |

**Live URL:** https://is-migration-sd.azurewebsites.net

### Azure App Settings
```
DATABASE_URL=postgresql://copadmin:CopPlatform%402025!@cop-postgres-srv.postgres.database.azure.com/integration_migration?sslmode=require
PORT=8080
NODE_ENV=production
BOOMI_API_BASE=https://api.boomi.com/api/rest/v1
```
Password is `CopPlatform@2025!` — `@` → `%40`, `!` → `%21` in URL.

### CI/CD — GitHub Actions
`.github/workflows/deploy.yml` fires on every push to `main`:
1. `npm install --production`
2. Zip artifact (includes node_modules — App Service does NOT run npm install from zip)
3. `azure/login@v2` with `creds: ${{ secrets.AZURE_CREDENTIALS }}` (JSON blob)
4. `az webapp deploy --type zip`

**CRITICAL — azure/login@v2:** Always use `creds:` JSON blob format.
Individual `client-id`/`tenant-id`/`client-secret` params use OIDC federation and will fail with "client-secret is not a valid input".

Required GitHub secret: `AZURE_CREDENTIALS` — full JSON from `az ad sp create-for-rbac --sdk-auth`

### Auto-Seed
`server.js` checks `COUNT(*) FROM projects` on boot. If 0 → calls `runSeed()` automatically.
No manual seed step needed after Azure cold start.

## Project Structure
```
IntegrationSuiteMigration/
├── server.js              — Express entry point; auto-seeds on first boot
├── database/
│   ├── db.js              — pool + initDb() — 6 tables
│   └── seed.js            — runSeed() — 4 projects, 90 artifacts
├── routes/
│   ├── projects.js        — CRUD /api/projects
│   ├── sources.js         — source connections + file upload + Boomi API sync
│   ├── artifacts.js       — assess / convert / qa / deploy / validate (6-step workflow)
│   ├── analysis.js        — complexity scoring engine
│   └── seed.js            — POST /api/seed endpoint
├── parsers/
│   ├── boomi.js           — Boomi component XML parser
│   ├── pipo.js            — SAP PI/PO XI export XML parser
│   ├── tibco.js           — TIBCO BW process XML parser
│   └── mulesoft.js        — MuleSoft mule-config XML parser
├── samples/               — demo XML files for each platform (for demo uploads)
├── .github/workflows/
│   └── deploy.yml         — GitHub Actions CI/CD
└── public/index.html      — complete SPA (dark navy sidebar, 5 pages, 6-tab artifact detail)
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

## Demo Data (4 Projects, 90 Artifacts)
| Project | Customer | Platform | Artifacts |
|---------|----------|----------|-----------|
| GlobalTech Manufacturing | GlobalTech Industries Inc. | Boomi | 30 |
| ACME Logistics | ACME Logistics GmbH | SAP PI/PO | 20 |
| TechCorp Digital | TechCorp Financial Services Ltd. | MuleSoft | 18 |
| RetailCo Operations | RetailCo International PLC | TIBCO | 22 |

## Supported Platforms
- **Boomi** — AtomSphere component XML / REST API (mock fallback for demo)
- **PIPO/SAP PI** — XI export format (IntegrationRepository XML)
- **TIBCO** — BusinessWorks process XML
- **MuleSoft** — Mule configuration XML

## Complexity Scoring Formula
`score = (shapes×1.5 + connectors×2.0 + maps×2.5 + scripting×2.0 + error_handling×1.0 + dependencies×1.0) / MAX × 100`

Levels: Simple (≤34), Medium (35–64), Complex (65+)
T-Shirt: XS(≤20)=1d · S(21-34)=2d · M(35-64)=5d · L(65-79)=12d · XL(80-100)=18d

## UI Design Rules
- Dark navy sidebar: `#1C2B3A`, accent: `#0066CC` (Sierra Digital branding)
- 5 pages: Overview · Assets (list) · Asset Detail (6-tab) · Runs · Settings
- 6 tabs per artifact: Assessment · Conversion · QA · Deployment · Validation · iFlow Preview
- Frontend is **pure vanilla JS/CSS** — edit `public/index.html` directly, no npm build

## What to Avoid
- Do NOT add React/Vite — frontend is intentionally a single-file HTML SPA
- Do NOT use individual credential params with `azure/login@v2` — use `creds:` JSON blob only
- Do NOT provision new PostgreSQL servers — reuse `cop-postgres-srv` (Central US, COP-Platform RG)
- Do NOT create new resource groups — use `rg-hana-migration` (no permission to create new RGs)
- Always URL-encode special chars in DATABASE_URL: `@` → `%40`, `!` → `%21`
- Include `node_modules` in zip deploy — App Service does NOT run npm install from zip
