---
name: IS Migration — Sprint Plan (Revised 2026-04-11)
description: Full sprint plan for MuleSoft/TIBCO/Boomi → SAP IS iFlow conversion accelerator
type: project
---

# Integration Suite Migration Accelerator — Sprint Plan

## Vision
A production-grade migration accelerator that ingests real MuleSoft (3.x/4.x), TIBCO BW5/BW6,
Boomi, and SAP PI/PO artifacts and generates **importable SAP Integration Suite iFlow packages**
with real connector mappings, actual transformation content, and a conversion quality score.
Not stubs. Not estimates. Real generated artefacts that import cleanly into SAP IS.

The system learns from every ZIP uploaded — patterns seen in real customer environments build
the knowledge base so the tool gives grounded, data-backed migration guidance.

---

## Strategy (agreed 2026-04-11)

```
Phase 1 — Test        : Run all real samples through the full pipeline; document what passes/fails
Phase 2 — Comprehend  : Fix every extractor gap found; cover all real-world patterns
Phase 3 — Generalise  : Intelligent ZIP upload → auto-detect → extract → DB → KB (learning loop)
Phase 4 — Polish      : Enterprise UI, SAP IS deploy, production quality
```

Each sprint in Phase 1–2 follows this cycle:
  1. Run artifact through pipeline
  2. Capture exact failure mode (screenshot or error log)
  3. Trace to root cause in extractor / assessment / conversion
  4. Fix and commit
  5. Re-run and mark pass in testing matrix
  6. Move to next artifact

---

## Sprint Tracker

| Sprint | Name                              | Status            | Phase |
|--------|-----------------------------------|-------------------|-------|
| S0     | Knowledge Base + MCP              | ✅ DONE           | -     |
| S1     | Data Foundation                   | ✅ DONE           | -     |
| S2     | iFlow Package Engine (base)       | ✅ DONE           | -     |
| S3     | MuleSoft Connectors               | ✅ DONE           | -     |
| S4     | MuleSoft Flow Structure           | ✅ DONE           | -     |
| S5     | MuleSoft Transformation           | ✅ DONE           | -     |
| S6     | MuleSoft Error Handling           | ✅ DONE           | -     |
| S7     | TIBCO BW6 Conversion              | ✅ DONE           | -     |
| S8     | TIBCO BW5 Conversion              | ✅ DONE           | -     |
| S9     | Boomi Enhancement                 | ⏸ DEFERRED        | -     |
| S10    | Conversion Quality Engine         | ✅ DONE           | -     |
| S11    | Migration Intelligence Chat       | ✅ DONE           | -     |
| **S12**| **Real Artifact Testing — Assess**| **▶ CURRENT**     | 1     |
| S13    | Real Artifact Testing — Convert   | NEXT              | 1     |
| S14    | MuleSoft Extractor Hardening      | PENDING           | 2     |
| S15    | TIBCO BW6 Extractor Hardening     | PENDING           | 2     |
| S16    | TIBCO BW5 Extractor Hardening     | PENDING           | 2     |
| S17    | Intelligent ZIP Ingestion Engine  | PENDING           | 3     |
| S18    | KB Auto-Enrichment + Learning     | PENDING           | 3     |
| S19    | Enterprise UI Redesign            | PENDING           | 4     |
| S20    | SAP IS Deploy API                 | PENDING           | 4     |
| S21    | End-to-End Validation             | PENDING           | 4     |

---

## SPRINT 12 — Real Artifact Testing: Assessment Pass (CURRENT)

**Goal**: Every one of the 24 seeded real artifacts produces a correct, complete Assessment report
with no `undefined`, `[object Object]`, zero-counts, or missing sections.

**Test matrix lives in**: `docs/TESTING_REPORT.md` — update it after every test run.

**How to run a test cycle**:
1. Log in to https://is-migration-sd.azurewebsites.net
2. Navigate to Project → "Real Artifact Tests" → Source → artifact
3. Click "Assess" — read the full report
4. Check each section against the pass criteria below
5. Record result in TESTING_REPORT.md

**Assessment pass criteria**:
```
✓ Platform shown correctly (MULESOFT / TIBCO-BW6 / TIBCO-BW5) — not 'BOOMI'
✓ Shapes count > 0
✓ Connectors count: matches actual source (e.g. SMTP=1, JDBC=1, HTTP=0 for inbound-only)
✓ Maps count: matches DataWeave/XSLT count in source XML
✓ Complexity score > 0 and level is Low/Medium/High
✓ Structural Analysis: shows real step names, not "Key steps: (empty)"
✓ Connectors & Adapters: correct connector types listed, not "All adapters: HTTP" for everything
✓ Data Mapping Analysis: real transform names, not "undefined: undefined complexity"
✓ Identified Challenges: text strings, not "[object Object]"
✓ Custom scripting: language shown (dataweave / xslt / java), not "undefined — unnamed"
✓ No console errors in Azure App Service logs
```

**Bugs already fixed before S12 started** (committed 2026-04-11):
- [x] `[object Object]` in challenges badge — `c.challenge` fix
- [x] `undefined — name` in scripting — `s.language || s.type` fix
- [x] MuleSoft connectors=0 — `outbound-endpoint` generic handler + globalConnectorMap
- [x] flow-ref sibling flows not walked — `_siblingFlowMap` recursion
- [x] `undefined: undefined complexity` in DataWeave mapping — use `pd.scripts` not `pd.dataWeaveTransforms`
- [x] TIBCO assessment never triggered — platform normalised `tibco-bw*` → `tibco`
- [x] TIBCO mapping blank — `xsltTransforms` fallback alongside `mappers`

**Expected failures to find and fix in S12**:
- BW5 artifacts: `pd.platform` may return undefined from raw extractor → assessment falls to boomi branch
- Some MuleSoft artifacts: connectorTypes may still be empty for non-standard element names
- TIBCO BW6: `connectors_count` may not reflect actual HTTP/JDBC activities
- BW5 SOAPOverEMS: SOAP+JMS dual connector may only show one

---

## SPRINT 13 — Real Artifact Testing: Convert → Download Pass

**Goal**: Every artifact that passes Assessment can also Convert and produce a downloadable,
structurally valid iFlow ZIP — even if some steps are stubs.

**Convert pass criteria**:
```
✓ "Convert" button does not return 500 error
✓ iFlow ZIP downloads without error
✓ ZIP contains: META-INF/MANIFEST.MF, *.iflw, parameters.prop
✓ .iflw file is valid BPMN2 XML (parseable, namespace-correct)
✓ Sender adapter section populated (not empty channel config)
✓ Receiver adapter section has at least one entry
✓ Groovy scripts present for each DataWeave/Java activity
✓ XSLT files present for each mapping step (BW6/BW5)
✓ Conversion notes section lists any UNMAPPED_CONNECTOR or SCRIPTING_PRESERVED flags
✓ Quality score > 0% (even stubs count)
```

**Test each artifact**: Record convert result in TESTING_REPORT.md alongside assess result.

---

## SPRINT 14 — MuleSoft Extractor Hardening

**Goal**: Based on S12/S13 findings, make `services/iflow-generator-mulesoft.js` handle
every real-world Mule 3.8 pattern present in the anypoint-examples-3.8 sample set.

**Known gaps to address** (update this list during S12):
- `ee:transform` (Mule 4 / DataWeave 2.0) — currently only `transform-message` (DW 1.0) handled
- `apikit:router` — generates single flow stub; should split into one iFlow per HTTP operation
- `vm:outbound-endpoint` — VM connector (in-memory) → IS process call step
- `file:outbound-endpoint` → SFTP receiver (after stripPrefix: `outbound-endpoint` now generic — verify)
- `amqp:*` → AMQP adapter
- `ws:consumer` (web service consumer) → SOAP receiver
- Global error handler (`<catch-exception-strategy>` at mule root) not scoped to flow
- `batch:job` / `batch:step` — iterating splitter pattern
- `objectstore:*` — flag as manual; no native IS adapter
- Session variables (`sessionVars.*`) — MEL → IS exchange property equivalent

**Hardening process**:
1. For each anypoint-example artifact, inspect `raw_xml` in DB
2. List every XML element type present
3. Check if `walkFlowElement` handles it
4. Add handler or fallback note if not

---

## SPRINT 15 — TIBCO BW6 Extractor Hardening

**Goal**: Make `services/iflow-generator-tibco-bw6.js` handle all BW6 patterns from
the bw-samples-master sample set (TN2018 CreditApp, ExperianDemo, etc.).

**Known gaps to address** (update during S12):
- `bw.http.Send` / `bw.http.Receive` activity type IDs → HTTP receiver/sender
- `bw.jms.PublishMessage` → JMS receiver adapter
- `bw.jdbc.QueryActivity` / `bw.jdbc.UpdateActivity` → JDBC receiver
- `bw.soap.InvokeSOAPService` → SOAP receiver
- `bw.file.Write` / `bw.file.Read` → SFTP receiver/sender
- `bw.generalactivities.callprocess` → Process call (subprocess iFlow)
- Timer starter (`bw.generalactivities.Timer`) → Timer start event
- Fault handler `<bpws:faultHandlers>` scoped to process level
- Multiple outbound links from single activity = Multicast step
- `bw.generalactivities.counter` → Content Modifier (header counter)

**XSLT extraction quality**:
- Verify HTML-unescaping correctly restores all XSLT 1.0 constructs
- Handle namespaces in XSLT correctly for SAP IS import
- Test that imported XSLT step runs in IS without modification

---

## SPRINT 16 — TIBCO BW5 Extractor Hardening

**Goal**: Make `services/iflow-generator-tibco-bw5.js` handle the full KPN SOAPGateway
BW5 pattern set (2,080 .process files — all patterns represented).

**Known gaps to address** (update during S12):
- `pd:starter` type=SOAP over EMS → JMS sender + SOAP parsing step
- HTTP client activity without explicit `<pd:type>` → infer from partner link
- Mapper `inputBinding` expressions — XPath-only vs full XSLT
- `pd:group` type=transaction (not error) → mark as manual transaction note
- SubProcess `pd:activity` — call graph: if inline, expand; if external, process call step
- Shared resource `.alias` files: parse JDBC/JMS/HTTP config into `parameters.prop`
- `com.tibco.pe.core.GenerateErrorActivity` → Error end event

**BW5 SOAPOverEMS pattern** (key for KPN):
- Starter: `SOAPEventSource` over EMS JMS transport
- Pattern: JMS Sender → SOAP parse → processing → SOAP reply → JMS reply
- Maps to: IS JMS Sender Adapter → XML-to-JSON → steps → JSON-to-XML → JMS Receiver Adapter

---

## SPRINT 17 — Intelligent ZIP Ingestion Engine

**Goal**: Upload any ZIP via UI → auto-detect platform → extract ALL artifacts → populate DB
→ quality engine auto-runs → KB enriched with patterns found.

**The "learning loop"**:
```
Upload ZIP
  → detect platform (scan extensions + XML root elements)
  → extract N artifacts (recursive, parallel)
  → for each: raw_xml stored, metadata derived, quality scored
  → KB updated: "Saw HTTP+JDBC pattern in 12 MuleSoft flows → standard REST-to-DB pattern"
  → chat agent can now say: "In the 12 REST-to-DB flows from your upload, we recommend..."
```

**UI flow**:
1. New "Upload Project" button on project page
2. Shows platform detection confidence: "Detected: MuleSoft 3.8 (47 flows found)" — confirm or override
3. Progress bar: parsing → extracting → scoring
4. Final summary: "47 artifacts created, 8 ready to auto-convert, 32 partial, 7 manual"

**Platform detection logic**:
```
ZIP contains *.bwp         → TIBCO BW6
ZIP contains *.process     → TIBCO BW5
ZIP contains mule-*.xml    → MuleSoft 3.x
ZIP contains *.xml with <ee:mule> or <mule xmlns:ee> → MuleSoft 4.x
ZIP contains *.component or *-process.xml → Boomi
ZIP contains *.ifl         → SAP PI/PO (ESR)
ZIP contains ICO.xml       → SAP PI/PO (ID)
```

**Key files**:
- `services/zip-ingestion.js` — new: platform detection + recursive extraction
- `routes/upload.js` — new: multipart upload endpoint + streaming progress
- `public/index.html` — upload UI with progress feedback

---

## SPRINT 18 — KB Auto-Enrichment + Learning

**Goal**: Every ZIP ingestion contributes structured knowledge to `knowledge_base` table,
making the chat agent progressively more grounded in real customer patterns.

**Knowledge patterns to extract**:
```
- Connector distribution: "72% of BW6 processes use HTTP; 41% use JDBC"
- Complex transform ratio: "28% of DataWeave scripts are complex (>10 lines, uses map/filter)"
- Error handling coverage: "Only 34% of BW5 processes have explicit error handling"
- Sub-process depth: "Average call depth 2.3 levels in BW5 corpus"
- Unmapped connector rate: "8% of MuleSoft flows have MongoDB (will need manual adapter work)"
```

**KB table additions**: category `upload_patterns`, keyed by platform + pattern_type
**Chat agent update**: query `upload_patterns` when answering "how long will migration take?"

---

## SPRINT 19 — Enterprise UI Redesign

**Goal**: Professional, demo-ready interface that Sriman can show to CEO and clients.

**Key design changes**:
- Replace floating 🤖 chat button with collapsible right-rail panel (VS Code style, 380px width)
- Pipeline view header: Upload → Parse → Assess → Convert → Quality → Deploy (with real-time status dots)
- Artifact cards: richer — show platform badge, complexity ring, readiness traffic light, quick-actions row
- Project dashboard: conversion funnel chart (Total → Assessed → Converted → Ready → Deployed)
- Assessment report: tabbed (Summary | Findings | Challenges | Risks | Conversion Plan)
- All styling via CSS Modules + design tokens (no inline styles — per CLAUDE.md)

---

## SPRINT 20 — SAP IS Deploy API

**Goal**: One-click deploy of converted iFlow ZIP directly to customer's SAP IS tenant.
**Blocker**: Needs SAP IS API credentials from Sriman — pending.

**When unblocked**:
- Use SAP Integration Suite OData API: `POST /api/v1/IntegrationDesigntimeArtifacts`
- Auth: OAuth2 client credentials (client_id + client_secret from IS service key)
- Store credentials encrypted in `source_connections` table per project
- Deploy endpoint: `routes/artifacts.js` — new `POST /api/artifacts/:id/deploy`

---

## SPRINT 21 — End-to-End Validation

**Goal**: Full regression with real SAP IS sandbox import validation.

**Test checklist**:
- [ ] Upload anypoint-examples-3.8.zip → all 15 artifacts parse + assess correctly
- [ ] Convert all 15 MuleSoft → download each ZIP → import into SAP IS sandbox → no import errors
- [ ] Upload bw-samples-master → all BW6 artifacts pass assess + convert
- [ ] Upload KPN SOAPGateway (BW5) → sample of 20 process files → assess + convert
- [ ] Verify Groovy stubs have no syntax errors in IS runtime
- [ ] Verify XSLT mapping steps run without modification in IS
- [ ] Chat agent answers grounded in uploaded pattern KB
- [ ] Full Azure regression: login, upload, pipeline, download, deploy

---

## Technical Reference

### Platform normalisation (assessment.js)
```javascript
rawPlatform.startsWith('tibco')      → 'tibco'    // covers tibco-bw5, tibco-bw6, tibco_bw5
rawPlatform.startsWith('mule')       → 'mulesoft'  // covers mulesoft, mule, mulesoft-3
rawPlatform.includes('pi/po')|'pipo' → 'pipo'
rawPlatform === 'boomi'              → 'boomi'
```

### xml2js stripPrefix behaviour (CRITICAL)
`tagNameProcessors: [xml2js.processors.stripPrefix]` removes namespace prefix from element keys:
- `smtp:outbound-endpoint` → key `outbound-endpoint`
- `http:request`           → key `request`
- `dw:transform-message`  → key `transform-message`
- `jms:outbound-endpoint`  → key `outbound-endpoint`  ← same key as SMTP!

**Rule**: Never rely on `k.includes('smtp:')` etc. Always use the global connector map
(build from root-level named connector configs) + resolve via `connector-ref` attribute.

### MuleSoft doc.mule parse shape
`doc.mule` is an **OBJECT** (not array) when the mule element is the only root.
Keys: `$` (xmlns attrs), `gmail-connector`, `listener-config`, `flow` (array of flows).
`doc.mule[0]` = `undefined`. Always use: `Array.isArray(muleEl) ? muleEl[0] : muleEl`

### BW6 activity extraction (activityTypeID)
`activityTypeID` is in attribute (not stripped by stripPrefix) of `BWActivity` element:
`el?.config?.[0]?.BWActivity?.[0]?.['$']?.activityTypeID`
Examples: `bw.generalactivities.log`, `bw.http.Send`, `bw.jdbc.QueryActivity`

### Complexity scoring formula
`score = shapes*4 + connectors*8 + maps*6 + scripts*10 + errorHandlers*5` (capped at 100)
Low < 40, Medium 40–69, High 70+

### SAP IS iFlow ZIP structure
```
{iflow-name}/
  META-INF/MANIFEST.MF
  src/main/resources/scenarioflows/integrationflow/{iflow-name}.iflw  ← BPMN2 XML
  src/main/resources/parameters.prop
  src/main/java/*.groovy   (optional Groovy scripts)
  mapping/*.xsl            (optional XSLT files)
```

### DB schema key facts
- `artifacts.platform` stores raw value: `mulesoft`, `tibco`, `tibco-bw5`, `tibco-bw6`
- `artifacts.raw_xml` stores full source XML (whole file for MuleSoft, full .bwp for BW6)
- `source_connections.type` (not `connection_type`); `platform` (not `source_platform`)
- Seed script: `node database/seed-real-artifacts.js` — idempotent, safe to re-run
- Real artifact project: id=16, source_connection id=16

---

## How to resume any session

1. Read this file (`docs/SPRINT_PLAN.md`) — find current sprint (▶ CURRENT)
2. Read `docs/SESSION_CONTEXT.md` — live state, last tested, what's broken
3. Read `docs/TESTING_REPORT.md` — artifact test matrix, pass/fail per stage
4. Run `git log --oneline -8` — see what was last committed
5. Pick up from where the last session left off (check SESSION_CONTEXT.md "Last action")
6. Say "go S{N}" to start a sprint, or "continue S{N}" to resume mid-sprint

**No need to re-derive any of the technical facts above — they are memorised from real analysis.**
