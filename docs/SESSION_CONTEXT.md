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
**S14 — MuleSoft Extractor Hardening** (▶ NEXT)
See `docs/SPRINT_PLAN.md` for full definition.

## Last Action (update this every session end)
> 2026-04-17 (session 2): SAP IS Import Fix — Root cause found and fixed. ZIP not yet confirmed working.
>
> Commits (this session):
>   31831ca — fix: add SupportedPlatform/mode to metainfo.prop; fix project download structure
>   7ff7851 — fix: align Package-Name/bundleid; remove em-dash from metainfo.prop
>   eccc398 — fix: use STORED ZIP for outer content package (ROOT CAUSE FIX)
>   8b580fb — chore: remove unused AdmZip import from projects route
>
> ROOT CAUSE IDENTIFIED:
>   adm-zip compresses ALL entries with DEFLATE (method=8), including metainfo.prop.
>   SAP IS's content package importer reads metainfo.prop raw bytes during quick validation
>   (does NOT decompress) — so it received garbled deflate output and rejected the package.
>   Fix: replaced adm-zip outer ZIP with custom buildStoredZip() (method=0, STORED).
>   metainfo.prop is now plain text bytes, readable by SAP IS without decompression.
>
> COMPLETED ACTIONS (this session):
>   1. ✅ Added SupportedPlatform=CloudIntegration + mode=DESIGN_TIME to metainfo.prop
>   2. ✅ Fixed project download — was triple-nested; now proper content package structure
>   3. ✅ Fixed bundleid/Package-Name mismatch (project download pkgId = safeProj_IS_Package)
>   4. ✅ Removed em-dash from shortText (non-ASCII breaks Java ISO-8859-1 props parser)
>   5. ✅ Bundle-Name now equals Bundle-SymbolicName (no spaces — matches SAP IS export format)
>   6. ✅ generateIFlowPackage now returns bundleBuffer (inner) + buffer (outer content pkg)
>   7. ✅ buildStoredZip() added to engine/iflow.js — pure Node.js, no external deps
>   8. ✅ Outer filename changed from INT_Migration_Package_v1_v1.0.zip → INT_Migration_Package_v1.zip
>
> PENDING:
>   • Re-download from live app AFTER eccc398 deploys and re-test SAP IS import
>   • Confirm import succeeds end-to-end (no further errors)
>   • If import succeeds but deploy fails → that is a separate BPMN2 content issue, not ZIP format
>   • S14 (MuleSoft Extractor Hardening) not yet started

> 2026-04-16: S13 COMPLETE — All 24 artifacts successfully converted and downloaded. Validation:
>
> Commit 56b9a4d — SESSION_CONTEXT handoff update (2026-04-13)
> Commit d9fdc42 — Real vs Mock/Demo path separation (S14 arch) (2026-04-13)
> Commit 730dc6f — S13 Bug fixes round 2 (2026-04-12)
>
> COMPLETED ACTIONS:
>   1. ✅ All 24 iFlows converted: 15 MuleSoft + 5 BW6 + 4 BW5
>   2. ✅ Downloaded to test-data/Real_Artifact_Tests_IS_ContentPackage_2026-04-15/
>   3. ✅ Validation: All ZIPs contain valid BPMN2 + XSLT/Groovy + parameters.prop
>   4. ✅ S13 Pass Criteria Met:
>        • Zero 500 errors on Convert
>        • All ZIPs download + unzip successfully
>        • BPMN2 XML valid in all 24 iFlows
>        • Sender + Receiver adapters populated
>        • Groovy scripts present for DataWeave transforms
>        • Quality scores generated (Low/Medium/High complexity)
>   5. ✅ Evidence saved: test-data/ contains full package with PACKAGE_MANIFEST.yaml
>
> READY FOR S14:
>   • S13 pass matrix in TESTING_REPORT.md complete
>   • No blockers for S14 (MuleSoft Extractor Hardening)
>   • 24 artifacts validated — ready for pattern analysis & KB hardening

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
- S13 Convert/Download re-audit still pending (need fresh run on MacBook Air after Azure deploy)
- BW5 extractor: `pd.platform` must return `'tibco-bw5'` — verify it does (check extractBw5PlatformData return)
- MuleSoft `request` (stripped from `http:request`): added `k === 'request'` check — verify it doesn't
  catch non-HTTP request elements
- `scatter-gather` internal branches not walked for connectors (expression-components, not real connectors — OK)
- Boomi: deferred (no real sample files, trial API limitations)
- SAP PI/PO: not started
- MacBook Air: whitelist its IP in Azure Postgres firewall before running seed script
  (Settings → Connection Security → add IP)

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
