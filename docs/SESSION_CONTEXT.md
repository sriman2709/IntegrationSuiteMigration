# Session Context — IS Migration Accelerator

## How to resume any session

At the start of every Claude session in this project:
1. Read `docs/SPRINT_PLAN.md` — find the current sprint (look for **NEXT** status)
2. Read `docs/CONVERSION_ANALYSIS.md` — connector/transform/trigger patterns from sample analysis
3. Check `git log --oneline -10` to see what was last committed
4. Say "go S{N}" to start the next sprint

## Current State (last updated by Claude)

| Item | Value |
|------|-------|
| Live URL | https://is-migration-sd.azurewebsites.net |
| DB | cop-postgres-srv (Azure Central US) |
| Repo | github.com/sriman2709/IntegrationSuiteMigration |
| Branch | main (CI/CD auto-deploys on push) |
| Login password | ISMigr8@SLB#Demo2025! |
| Current sprint | **S7 — TIBCO BW6 Conversion** |

## What's already built (pre-sprint)
- Full assessment tool: upload ZIP/JAR/XML, parse, artifact cards, complexity scoring
- Login/auth (express-session), Azure deploy via GitHub Actions
- MuleSoft deep parser (Mule 3 + 4, ZIP/JAR recursive)
- TIBCO BW5 parser (ProcessDef)
- TIBCO BW6 parser (BPWS/BPEL format)
- engine/iflow.js — iFlow .zip generator (stubs, real data feeds in from S3+)
- engine/conversion.js — conversion plan generator (stubs)

## Sprints done
- **S0** ✅ — knowledge_base table + MCP server (mcp/knowledge-server.js) + 28 seeded knowledge entries
- **S1** ✅ — raw_xml column + conversion_status/iflow_xml/conversion_notes in artifacts; all parsers store source XML
- **S2** ✅ (existed) — engine/iflow.js package generator
- **S3** ✅ — MuleSoft connector extraction from raw_xml; all adapters mapped; services/iflow-generator-mulesoft.js
- **S4** ✅ — engine/iflow-mulesoft-bpmn.js (real BPMN2 step builder); wired into buildFullBPMN() in iflow.js via pd.processors detection
- **S5** ✅ — buildMuleSoftGroovyScripts() in iflow.js; DW 1.0 → Groovy stubs with original DataWeave preserved as comment block; one .groovy file per transform step
- **S6** ✅ — Already wired in S4: buildExceptionSubprocesses() in iflow-mulesoft-bpmn.js; catch/choice-exception-strategy → BPMN2 exception subprocesses with error start/end events
- **S7** 🔄 IN PROGRESS — services/iflow-generator-tibco-bw6.js created (BW6 parser: DAG topo-sort, HTML-unescape XSLT, fault handlers, sender/receiver config); next: engine/iflow-tibco-bw6-bpmn.js + wire into iflow.js + routes/artifacts.js resolvePlatformData

## S7 — What's left to complete
1. Create `engine/iflow-tibco-bw6-bpmn.js` — BPMN2 builder for BW6 (mirror of iflow-mulesoft-bpmn.js but using BW6 processor types: xslt, invoke, router, scope)
2. In `engine/iflow.js`: add `require('./iflow-tibco-bw6-bpmn')`, add BW6 branch in `buildFullBPMN()` (detect `platform === 'tibco-bw6' && pd.processors.length > 0`), emit `.xsl` files in ZIP for each `pd.xsltTransforms` entry (similar to how Groovy scripts are emitted)
3. In `routes/artifacts.js`: update `resolvePlatformData()` to call `extractBw6PlatformData(art)` when `art.platform === 'tibco-bw6' && art.raw_xml`
4. Update `buildMuleSoftGroovyScripts` pattern: BW6 uses XSLT not Groovy — emit `.xsl` files not `.groovy`
5. Commit, push, mark S7 done, set S8 NEXT

## Sample files (for testing — on OneDrive)
- MuleSoft: `OneDrive/projects/anypoint-examples-3.8.zip`
- TIBCO BW6: `OneDrive/projects/bw-samples-master.zip`

## Key technical facts (never re-derive these)
- MuleSoft 3.8 uses DataWeave **1.0** (`%dw 1.0`) — NOT DataWeave 2.0
- TIBCO BW6 XSLT is HTML-escaped in `expression` attribute — unescape to get valid XSLT 1.0 (SAP IS-native)
- MongoDB has NO native SAP IS adapter — suggest HTTPS/MongoDB Atlas REST API
- SAP IS iFlow zip: META-INF/MANIFEST.MF + src/main/resources/scenarioflows/integrationflow/{id}.iflw
- Azure session needs `app.set('trust proxy', 1)` for SSL termination

## MCP Knowledge Server
Start: `npm run mcp` (from project root)  
Re-seed: `npm run seed:knowledge`  
Table: `knowledge_base` in cop-postgres-srv  
Tools: search_knowledge, save_knowledge, list_categories, get_sprint_context

## Claude Desktop MCP config (add to ~/.claude.json or claude_desktop_config.json)
```json
{
  "mcpServers": {
    "is-migration-knowledge": {
      "command": "node",
      "args": ["/Users/parisuchitha/projects/IntegrationSuiteMigration/mcp/knowledge-server.js"],
      "env": { "DATABASE_URL": "<Azure Postgres connection string from .env>" }
    }
  }
}
```
