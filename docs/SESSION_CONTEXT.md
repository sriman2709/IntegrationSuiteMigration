# Session Context — IS Migration Accelerator
# ============================================
# READ THIS FILE at the start of EVERY Claude session.
# It is the live state of the project — always more current than memory.

## Live URLs & Credentials
| Item | Value |
|------|-------|
| Live app | https://is-migration-sd.azurewebsites.net |
| Login password | ISMigr8@SLB#Demo2025! (also DEMO_PASSWORD in App Settings) |
| Repo | github.com/sriman2709/IntegrationSuiteMigration |
| Branch | main (CI/CD: push → Azure auto-deploys, ~3 min) |
| DB | cop-postgres-srv.postgres.database.azure.com, db=integration_migration, user=copadmin |
| Node on Azure | v20.20.0 (Linux container) |
| OpenAI key | set in Azure App Settings as OPENAI_API_KEY |
| Azure CLI account | s.sundararaman@sierradigitalinc.com |
| Mac IP whitelisted | 106.192.76.246 (current network) + 122.167.99.66 (MacBookPro home) for Postgres |

## Current Sprint
**S13 — Real Artifact Testing: Convert → Download Pass** (▶ ACTIVE as of 2026-04-12)
See `docs/SPRINT_PLAN.md` for full definition.

## Last Action (update this every session end)
> 2026-04-12: S12 complete. All 24 artifacts assessed. Fixed systemic bugs across 3 sessions:
> - BW5 activity type read from child element (not attr) — e26547a
> - MuleSoft stripPrefix for db/ws/batch/sfdc/mongodb — 1204945
> - batch:job root elements not walked (Salesforce_To_MySQL_Batch) — 2b5d50d
> - batch:input container missing from walk list — 2b5d50d
> - 4 assessment engine bugs (challenges/scripting/connectors/DataWeave) — e1193f2
> Added: Bulk Assess (bf66c7c), Export All Assessments (6d7676e)
> S12 known residual gaps (moved to S14 backlog):
>   - BW6_Credit_App_Main/Credit_Check_Backend: scope-only (1 step) — BW6 scope walking gap
>   - CSV_To_MongoDB: MongoDB not in connectorTypes — ambiguous stripped op names
> Starting S13: Click Convert on each of 24 artifacts; verify ZIP downloads with valid BPMN2.

## What's Built and Working
- Upload ZIP → parse → artifact cards (MuleSoft, BW5, BW6, Boomi)
- Assessment engine: per-platform, complexity scoring, challenges, risks, connectors
- Conversion engine: generates iFlow ZIP (MuleSoft, BW6, BW5 → BPMN2 + XSLT + Groovy)
- Quality engine: completeness score, flags (UNMAPPED_CONNECTOR, SCRIPTING_PRESERVED, etc.)
- Chat agent: GPT-4o streaming (lazy OpenAI init — no startup crash)
- Knowledge base: 28+ seeded entries, MCP server (npm run mcp)
- Real artifact test project: 24 seeded artifacts with real raw_xml (project id=16)
- Login/auth, Azure deploy, session management

## Real Artifact Test Project
Project: **"Real Artifact Tests"** (id=16, source_connection id=16)
Seed: `node database/seed-real-artifacts.js` (idempotent — safe to re-run)
Test files in: `test-data/` (gitignored locally)

| Platform | Count | Artifact Names |
|----------|-------|----------------|
| MuleSoft 3.8 | 15 | Hello_World_HTTP, HTTP_Request_With_Logger, Content_Based_Routing, Scatter_Gather_Flow, Foreach_And_Choice_Routing, Choice_Exception_Strategy, DataWeave_Orders_API, Database_To_JSON, JSON_To_JMS_Queue, CSV_To_MongoDB, SMTP_CSV_Email, SOAP_Webservice_Consumer, Service_Orchestration_Choice, Salesforce_To_MySQL_Batch, JMS_Rollback_Redelivery |
| TIBCO BW6 | 5 | BW6_Logging_Service, BW6_Credit_App_Main, BW6_Credit_Check_Backend, BW6_Credit_DB_Lookup, BW6_Equifax_Score |
| TIBCO BW5 | 4 | BW5_Common_SOAP_Handler, BW5_Startup_SOAP_Gateway, BW5_Invalid_Data_Handler, BW5_Get_WSDL |

Testing matrix: see `docs/TESTING_REPORT.md`

## Known Issues / Watch List
- BW5 extractor: `pd.platform` must return `'tibco-bw5'` — verify it does (check extractBw5PlatformData return)
- MuleSoft `request` (stripped from `http:request`): added `k === 'request'` check — verify it doesn't
  catch non-HTTP request elements
- `scatter-gather` internal branches not walked for connectors (expression-components, not real connectors — OK)
- Boomi: deferred (no real sample files, trial API limitations)
- SAP PI/PO: not started

## Key Files (never guess these paths)
```
server.js                             Express entry, port 4001
engine/assessment.js                  Assessment engine (platform-aware)
engine/iflow.js                       iFlow ZIP generator (all platforms)
engine/conversion.js                  Conversion plan generator
engine/quality.js                     Quality scoring
engine/iflow-mulesoft-bpmn.js         MuleSoft BPMN2 builder
engine/iflow-tibco-bw6-bpmn.js        BW6 BPMN2 builder
engine/iflow-tibco-bw5-bpmn.js        BW5 BPMN2 builder
services/iflow-generator-mulesoft.js  MuleSoft raw_xml extractor ← most complex
services/iflow-generator-tibco-bw6.js BW6 raw_xml extractor
services/iflow-generator-tibco-bw5.js BW5 raw_xml extractor
services/chat-agent.js                GPT-4o chat (lazy init)
routes/artifacts.js                   /api/artifacts (assess, convert, quality)
routes/chat.js                        /api/chat SSE
database/seed-real-artifacts.js       Seeds 24 real artifacts
public/index.html                     All frontend (SPA, ~2000 lines)
mcp/knowledge-server.js               MCP server (npm run mcp)
docs/SPRINT_PLAN.md                   ← YOU ARE READING SIBLING FILE
docs/TESTING_REPORT.md               ← Live test matrix
```

## Critical Technical Facts (never re-derive)
```
MuleSoft 3.8:
  - DataWeave 1.0: %dw 1.0, %output — NOT DataWeave 2.0
  - xml2js stripPrefix removes namespace prefix from element keys:
    smtp:outbound-endpoint → 'outbound-endpoint'
    http:request           → 'request'
    dw:transform-message   → 'transform-message'
  - doc.mule is OBJECT (not array): doc.mule[0] = undefined
  - doc.mule structure: { '$': {...xmlns...}, 'gmail-connector': [...], 'flow': [...] }
  - Resolve outbound connector type: globalConnectorMap[connector-ref] not k.includes('smtp:')

TIBCO BW6:
  - activityTypeID in BWActivity['$'].activityTypeID (attribute — not stripped)
  - XSLT is HTML-escaped in tibex:inputBinding 'expression' attribute — unescape to get valid XSLT 1.0
  - extractionActivity not extensionActivity — key after stripPrefix: 'extensionactivity'

TIBCO BW5:
  - .process = pd:ProcessDefinition root
  - pd:starter = trigger, pd:activity = step, pd:transition = link, pd:group = scope/error handler
  - Shared resources in .alias files (JDBC/JMS/HTTP)

Assessment:
  - platform normalised in runAssessment: tibco-bw* → 'tibco', mule* → 'mulesoft'
  - use artifact.platform (raw) for display, normalised platform for branch logic
  - pd.scripts (enriched, has name+complexity) preferred over pd.dataWeaveTransforms (raw)

MongoDB: NO native SAP IS adapter → HTTPS + MongoDB Atlas REST API
SAP IS iFlow ZIP: META-INF/MANIFEST.MF + *.iflw (BPMN2) + parameters.prop + *.groovy + *.xsl
Complexity: shapes*4 + connectors*8 + maps*6 + scripts*10 + errorHandlers*5 (capped 100)
```

## MCP Knowledge Server
```bash
npm run mcp        # start MCP server (port 3001)
npm run seed:knowledge  # re-seed 28 entries
```
MCP tools: search_knowledge, save_knowledge, list_categories, get_sprint_context

## Claude Desktop MCP config (any machine)
```json
{
  "mcpServers": {
    "is-migration-knowledge": {
      "command": "node",
      "args": ["/path/to/IntegrationSuiteMigration/mcp/knowledge-server.js"],
      "env": { "DATABASE_URL": "postgres://copadmin:<pwd>@cop-postgres-srv.postgres.database.azure.com/integration_migration?sslmode=require" }
    }
  }
}
```
