# Real Artifact Testing Report
# =============================
# Live test matrix — update after every test run.
# Stages: Parse (P) | Assess (A) | Convert (C) | Quality (Q) | Download (D)
# Status per stage: ✅ pass | ❌ fail | ⚠ partial | — not tested yet

## How to Test
1. Log into https://is-migration-sd.azurewebsites.net
2. Go to Project → "Real Artifact Tests" → Source → artifact
3. Run Assess → check report against criteria in SPRINT_PLAN.md S12
4. Run Convert → check ZIP downloads and contains valid structure
5. Update this table

## MuleSoft Artifacts (15)

| Artifact | Parse | Assess | Convert | Quality | Download | Notes |
|----------|-------|--------|---------|---------|----------|-------|
| Hello_World_HTTP | — | — | — | — | — | Simple HTTP listener + logger |
| HTTP_Request_With_Logger | — | — | — | — | — | HTTP in+out + logger |
| Content_Based_Routing | ✅ | ⚠ | — | — | — | 0 adapters (correct — no outbound). All adapters: blank fixed (e1193f2) |
| Scatter_Gather_Flow | ✅ | ✅ | — | — | — | SMTP connector ✅, DataWeave script ✅, header ✅ |
| Foreach_And_Choice_Routing | — | — | — | — | — | foreach + choice (loan broker) |
| Choice_Exception_Strategy | ✅ | ⚠ | — | — | — | Header null fixed (e1193f2). 0 outbound connectors (correct). 2 DW scripts ✅ |
| DataWeave_Orders_API | — | — | — | — | — | Expect SCRIPTING_PRESERVED flag |
| Database_To_JSON | — | — | — | — | — | Expect JDBC connector |
| JSON_To_JMS_Queue | — | — | — | — | — | Expect JMS connector |
| CSV_To_MongoDB | ✅ | ⚠ | — | — | — | Header null fixed (e1193f2). MongoDB connector not yet flagged — S14 gap |
| SMTP_CSV_Email | — | — | — | — | — | Expect SMTP connector |
| SOAP_Webservice_Consumer | — | — | — | — | — | Expect SOAP connector |
| Service_Orchestration_Choice | — | — | — | — | — | Multi-connector pattern |
| Salesforce_To_MySQL_Batch | — | — | — | — | — | Expect Salesforce + JDBC |
| JMS_Rollback_Redelivery | — | — | — | — | — | Expect JMS + error handling |

## TIBCO BW6 Artifacts (5)

| Artifact | Parse | Assess | Convert | Quality | Download | Notes |
|----------|-------|--------|---------|---------|----------|-------|
| BW6_Logging_Service | ✅ | ✅ | — | — | — | 5 steps, 1 map, HTTP ✅ header ✅ |
| BW6_Credit_App_Main | ✅ | ⚠ | — | — | — | 1 step (scope only extracted). HTTP ✅. maps=0 fix pending re-test (e1193f2) |
| BW6_Credit_Check_Backend | ✅ | ⚠ | — | — | — | 1 step + 2 deps. HTTP ✅. maps=0 fix pending re-test (e1193f2) |
| BW6_Credit_DB_Lookup | ✅ | ⚠ | — | — | — | JDBC fix applied (e1193f2) — re-test. steps: scope→QueryRecords→UpdatePulls→Throw |
| BW6_Equifax_Score | ✅ | ⚠ | — | — | — | 2 steps (scope+post). HTTP ✅. maps=0 fix pending re-test (e1193f2) |

## TIBCO BW5 Artifacts (4)

| Artifact | Parse | Assess | Convert | Quality | Download | Notes |
|----------|-------|--------|---------|---------|----------|-------|
| BW5_Common_SOAP_Handler | ✅ | ⚠ | — | — | — | 22 steps ✅, 1 adapter ✅. maps=0 fix pending re-test (e1193f2). Readiness=Auto ✅ |
| BW5_Startup_SOAP_Gateway | ✅ | ⚠ | — | — | — | 4 steps ✅. maps=0 fix pending re-test (e1193f2) |
| BW5_Invalid_Data_Handler | ✅ | ⚠ | — | — | — | 2 steps ✅. maps=0 fix pending re-test (e1193f2) |
| BW5_Get_WSDL | ✅ | ⚠ | — | — | — | 7 steps ✅. maps=0 fix pending re-test (e1193f2) |

---

## Bug Log (found during testing)

| Date | Artifact | Stage | Symptom | Fix | Commit |
|------|----------|-------|---------|-----|--------|
| 2026-04-11 | BW6_Logging_Service | Assess | 0 shapes, 0 connectors | Backfill from extracted pd | d86bb39 |
| 2026-04-11 | Scatter_Gather_Flow | Assess | [object Object] challenges | c.challenge render fix | c3959b8 |
| 2026-04-11 | Scatter_Gather_Flow | Assess | undefined scripting label | s.language\|\|s.type fallback | c3959b8 |
| 2026-04-11 | Scatter_Gather_Flow | Assess | 0 connectors (SMTP) | globalConnectorMap + outbound-endpoint | 92e89a1 |
| 2026-04-11 | All MuleSoft | Assess | DataWeave undefined:undefined | use pd.scripts not pd.dataWeaveTransforms | 2704105 |
| 2026-04-11 | BW6_Logging_Service | Assess | TIBCO section never triggered | platform normalise tibco-bw* → 'tibco' | 2704105 |
| 2026-04-11 | All 12 artifacts | Assess | Header: null complexity/tshirt/effort | refreshDetailHeader() after assess updates state.currentArtifact | e1193f2 |
| 2026-04-11 | MuleSoft (no outbound) | Assess | All adapters: blank | connectorTypes [] (empty array) not falling back — length guard added | e1193f2 |
| 2026-04-11 | All BW5 + most BW6 | Assess | maps_count = 0 | derivedMaps now includes pd.mappers (BW5 format) | e1193f2 |
| 2026-04-11 | BW6_Credit_DB_Lookup | Assess | Shows HTTP not JDBC | extensionActivity bw.jdbc.* now scanned via proc.config.connType | e1193f2 |

---

## Open Gaps (S14 backlog)

| Gap | Platform | Detail |
|-----|----------|--------|
| MongoDB not flagged as UNMAPPED_CONNECTOR | MuleSoft | CSV_To_MongoDB — connector type 'MongoDB' not in connectorTypes |
| BW6 scope-only extraction | BW6 | Credit_App_Main/Credit_Check_Backend: only 1 step (scope) extracted — activities inside scope not walked |
| BW5 maps_count accuracy | BW5 | After e1193f2 fix — re-test all 4 BW5 to confirm correct map count |

---

## Assessment Quality Checklist (use for each artifact)

```
[ ] Platform label correct (not BOOMI for MuleSoft/TIBCO)
[ ] shapes_count > 0
[ ] connectors_count correct (matches source)
[ ] maps_count correct
[ ] Complexity score > 0 and makes sense
[ ] Structural Analysis: real step names shown
[ ] Connectors & Adapters: correct types listed
[ ] Data Mapping: no "undefined: undefined complexity"
[ ] Challenges: no "[object Object]"
[ ] Custom scripting: language shown (not "undefined")
[ ] No Azure App Service 500 errors
```

## Convert Quality Checklist

```
[ ] Convert returns 200 (no 500)
[ ] ZIP downloads successfully
[ ] ZIP contains META-INF/MANIFEST.MF
[ ] ZIP contains *.iflw (BPMN2 XML)
[ ] ZIP contains parameters.prop
[ ] .iflw is valid XML (parseable)
[ ] Sender adapter section not empty
[ ] Receiver adapter(s) present
[ ] Groovy scripts for each DataWeave/Java step
[ ] XSLT files for each mapping step (BW5/BW6)
[ ] Conversion notes list any flags
[ ] Quality score > 0%
```
