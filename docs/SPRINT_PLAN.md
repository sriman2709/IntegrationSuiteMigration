---
name: IS Migration — Full iFlow Conversion Accelerator Sprint Plan
description: Exhaustive sprint-by-sprint build plan for real MuleSoft/TIBCO/Boomi → SAP IS iFlow conversion engine; read this at the start of every session
type: project
---

# Integration Suite Migration Accelerator — Sprint Plan

## Vision
A production-grade migration accelerator that ingests real MuleSoft (3.x/4.x), TIBCO BW5/BW6, Boomi, and SAP PI/PO artifacts and generates **importable SAP Integration Suite iFlow packages** — with real connector mappings, actual transformation content, and a conversion quality score. Not stubs. Not estimates. Real generated artefacts.

## Sample files used as reference (on disk)
- MuleSoft: `/Users/parisuchitha/Library/CloudStorage/OneDrive-SierraDigitalinc/projects/anypoint-examples-3.8.zip`
- TIBCO BW6: `/Users/parisuchitha/Library/CloudStorage/OneDrive-SierraDigitalinc/projects/bw-samples-master.zip`

## Key technical facts (memorised from analysis)
- MuleSoft 3.8: DataWeave **1.0** syntax (`%dw 1.0`, `%output`) in `<dw:transform-message>` CDATA blocks
- TIBCO BW6: ALL transforms are **XSLT 1.0** embedded as escaped strings in `tibex:inputBinding expression` attributes — extractable and usable natively in SAP IS mapping steps
- TIBCO BW5: `.process` XML (ProcessDef) with `.alias` shared resources
- SAP IS iFlow format: BPMN2 XML wrapped in a specific folder/manifest structure, importable as `.zip`
- MongoDB has **no native SAP IS adapter** — flag as manual, suggest HTTPS/OData alternative

---

## Sprint Tracker

| Sprint | Name | Status | Key deliverable |
|--------|------|--------|-----------------|
| S0 | Knowledge Base + MCP | **✅ DONE** | knowledge_base table, MCP server, 28 seeded entries (connector maps, patterns, rules) |
| S1 | Data Foundation | **✅ DONE** | raw_xml + conversion columns in artifacts; MuleSoft/TIBCO/Boomi parsers store source XML |
| S2 | iFlow Package Engine | **✅ EXISTS** | engine/iflow.js already built — stubs; S3+ feeds real data into it |
| S3 | MuleSoft Connectors | **✅ DONE** | All MuleSoft adapters mapped to SAP IS from raw_xml |
| S4 | MuleSoft Flow Structure | **✅ DONE** | choice/foreach/scatter-gather → real BPMN2 steps; engine/iflow-mulesoft-bpmn.js wired into iflow.js |
| S5 | MuleSoft Transformation | **NEXT** | DataWeave 1.0 → Groovy stub + preserved script |
| S6 | MuleSoft Error Handling | **PENDING** | Exception strategies → iFlow exception sub-process |
| S7 | TIBCO BW6 Conversion | **PENDING** | Full BW6 → iFlow with extracted XSLT |
| S8 | TIBCO BW5 Conversion | **PENDING** | ProcessDef → iFlow |
| S9 | Boomi Enhancement | **PENDING** | Boomi raw_xml + real iFlow generation |
| S10 | Conversion Quality Engine | **PENDING** | Completeness %, unmapped flags, conversion report |
| S11 | UI — Conversion Pipeline | **PENDING** | Real download, per-artifact status, report view |
| S12 | MuleSoft 4 Support | **PENDING** | Mule 4 namespace + DataWeave 2.0 differences |
| S13 | SAP PI/PO Migration | **PENDING** | PI/PO export → IS modernisation |
| S14 | End-to-End Validation | **PENDING** | Azure deploy + SAP IS sandbox import test |

**Current sprint to start next**: S5 — MuleSoft Transformation

---

## SPRINT 1 — Data Foundation
**Goal**: Store the raw source XML per artifact so the conversion engine has real material to work from. Without this nothing downstream works.

### DB changes
```sql
ALTER TABLE artifacts ADD COLUMN raw_xml TEXT;
ALTER TABLE artifacts ADD COLUMN conversion_status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE artifacts ADD COLUMN converted_at TIMESTAMP;
ALTER TABLE artifacts ADD COLUMN iflow_xml TEXT;
ALTER TABLE artifacts ADD COLUMN conversion_notes JSONB DEFAULT '[]';
```

### Parser changes
**mulesoft-service.js** — in `analyseFlow()`:
- Accept the raw flow XML string as a parameter
- Store it in returned artifact object as `raw_xml`
- Pass full XML of the `<flow>` element (serialised back from xml2js or sliced from original string)

**tibco-service.js** — in `analyseBw6Process()` and `analyseProcess()`:
- Accept the full `.bwp` or `.process` XML string
- Store in returned artifact as `raw_xml`

**boomi-service.js** (if exists):
- Same pattern — store full component XML

### Route change
`routes/artifacts.js` or `routes/sources.js`: ensure INSERT includes `raw_xml`

### Files to touch
- `database/migrations/` — new migration file
- `services/mulesoft-service.js`
- `services/tibco-service.js`
- `services/boomi-service.js`

---

## SPRINT 2 — iFlow Package Engine (Base)
**Goal**: A reusable engine that produces a valid, SAP IS-importable `.zip` from a structured iFlow descriptor object.

### SAP IS iFlow zip structure
```
<iflow-name>/
  META-INF/
    MANIFEST.MF
  src/
    main/
      resources/
        scenarioflows/
          integrationflow/
            <iflow-name>.iflw          ← BPMN2 XML (main file)
        parameters.prop                 ← externalized properties
      java/                             ← optional Groovy scripts
  pom.xml
```

### MANIFEST.MF format
```
Bundle-SymbolicName: <iflow-name>
Bundle-Name: <iflow-name>
Bundle-Version: 1.0.0
SAP-BundleType: IFlow
```

### iFlow BPMN2 XML skeleton
Key elements:
- `<bpmn2:definitions>` root with SAP namespaces
- `<bpmn2:collaboration>` containing `<bpmn2:participant>` (the integration process)
- `<bpmn2:process>` containing the actual steps
- `<bpmn2:startEvent>` with sender channel
- Steps: `<bpmn2:serviceTask>` for each processing step
- `<bpmn2:endEvent>` with receiver channel
- Channels: `<ifl:property>` elements per adapter

### Engine API
```javascript
// services/iflow-generator.js
generateIFlowZip(descriptor) → Buffer (ZIP)

// descriptor shape:
{
  name: string,
  trigger: { type: 'HTTP'|'Timer'|'JMS'|'SFTP', config: {} },
  steps: [{ type: 'ContentModifier'|'Router'|'Mapping'|'Call'|'Script', config: {} }],
  receiver: { type: 'HTTP'|'JDBC'|'JMS'|'SFTP'|'Salesforce'|'SAP', config: {} },
  errorHandling: { type: 'none'|'basic'|'full', steps: [] },
  properties: {}  // externalized params
}
```

### Files to create
- `services/iflow-generator.js` — core engine
- `services/iflow-templates.js` — BPMN2 XML string builders per adapter type

---

## SPRINT 3 — MuleSoft Connector Mapping
**Goal**: Map every MuleSoft connector to the correct SAP IS adapter configuration.

### Connector mapping table
| MuleSoft element | SAP IS Adapter | Channel direction | Config params |
|-----------------|----------------|-------------------|---------------|
| `http:listener` | HTTP | Sender | path, method, port |
| `http:request` | HTTP | Receiver | host, port, path, method, auth |
| `db:select` / `db:insert` | JDBC | Receiver | driver, URL, SQL, params |
| `jms:inbound-endpoint` | JMS | Sender | destination, type (queue/topic) |
| `jms:outbound-endpoint` | JMS | Receiver | destination, type |
| `sftp:inbound-endpoint` | SFTP | Sender | host, path, poll interval |
| `sftp:outbound-endpoint` | SFTP | Receiver | host, path, filename |
| `sfdc:*` | Salesforce | Receiver | operation, object, credentials |
| `sap:*` | IDoc/RFC | Receiver | type (IDoc/BAPI/RFC), function |
| `smtp:outbound-endpoint` | Mail | Receiver | host, from, to, subject |
| `cxf:jaxws-client` | SOAP | Receiver | WSDL url, operation |
| `web-service-consumer` | SOAP | Receiver | WSDL, operation |
| `mongo:*` | ❌ NO ADAPTER | — | Flag: use HTTPS/OData alternative |
| `file:inbound-endpoint` | SFTP (File) | Sender | directory, poll |
| `file:outbound-endpoint` | SFTP (File) | Receiver | directory, filename |
| `s3:*` | HTTPS | Receiver | AWS S3 REST API endpoint |
| `workday:*` | HTTPS | Receiver | Workday API endpoint |
| `servicenow:*` | HTTPS | Receiver | ServiceNow REST endpoint |
| `amqp:*` | AMQP | Receiver | host, exchange, routing key |

### Files to create
- `services/iflow-generator-mulesoft.js` — MuleSoft-specific generator
- References `services/iflow-generator.js` (Sprint 2 base)

---

## SPRINT 4 — MuleSoft Flow Structure Conversion
**Goal**: Convert MuleSoft flow control elements to equivalent SAP IS step patterns.

### Flow structure mapping
| MuleSoft | SAP IS equivalent | Notes |
|----------|-------------------|-------|
| `<flow>` main | Integration process sequence | Direct 1:1 |
| `<sub-flow>` | Process call to local iFlow | Separate iFlow artifact |
| `<flow-ref>` | Process Direct call step | Call by name |
| `<choice>` | Router with XPath/Groovy conditions | Extract `when` expressions |
| `<scatter-gather>` | Multicast (parallel) | With aggregation step after |
| `<foreach>` | Iterating splitter + gather | Loop pattern |
| `<enricher>` | Content enricher step | target variable → header |
| `<batch:job>` | Iterating splitter (bulk) | Note: limited batch support |
| `<async>` | Asynchronous step (fire-forget) | |
| `<cache>` | Local cache step (if available) | |
| `<transactional>` | Transaction handler | Note in conversion report |
| `<expression-component>` | Groovy script step | Preserve MEL code in Groovy stub |
| `<set-payload>` | Content Modifier (body) | |
| `<set-variable>` | Content Modifier (exchange property) | |
| `<set-property>` | Content Modifier (header) | |
| `<object-to-string-transformer>` | Content Modifier (convert) | |
| `<logger>` | Log step (trace) | |
| `<apikit:router>` | Multiple iFlow processes | One iFlow per HTTP operation |

### APIKit special handling
When an APIKit config is detected:
- Each `<apikit:flow-mapping>` becomes a **separate iFlow**
- Named: `{originalName}_{method}_{resource}` (e.g., `leagues_GET_teams`)
- All share the same HTTP sender adapter base path

### Files to update
- `services/iflow-generator-mulesoft.js`

---

## SPRINT 5 — MuleSoft Transformation Conversion
**Goal**: Extract real DataWeave 1.0 scripts and convert/preserve them in iFlow.

### DataWeave 1.0 extraction
From raw_xml, find `<dw:transform-message>` blocks, extract:
- `<dw:set-payload>` CDATA → main transform body
- `<dw:set-variable variableName="x">` CDATA → side outputs
- `<dw:set-property propertyName="x">` CDATA → header outputs

### DataWeave → SAP IS mapping step strategy
**Option A: XSLT wrapper** (preferred for simple transforms)
- Simple field mappings (`payload.firstName`) → convert to XSLT
- Works natively in SAP IS without Groovy

**Option B: Groovy script** (for complex DW logic)
```groovy
// Original DataWeave 1.0 script preserved below:
// %dw 1.0
// %output application/json
// ---
// { name: payload.firstName ++ " " ++ payload.lastName }
//
// TODO: Implement equivalent logic below:
import com.sap.gateway.ip.core.customdev.util.Message
def Message processData(Message message) {
    def body = message.getBody(String.class)
    // Add your transformation here
    message.setBody(body)
    return message
}
```

### DataWeave 1.0 → Groovy conversion rules
| DW 1.0 pattern | Groovy equivalent |
|----------------|-------------------|
| `payload.field` | `jsonSlurper.field` |
| `payload map { x: $.y }` | `payload.collect { [x: it.y] }` |
| `payload filter $.active` | `payload.findAll { it.active }` |
| `%output application/json` | `message.setBody(JsonOutput.toJson(...))` |
| `%output application/csv` | Manual CSV output |
| `payload ++ " " ++ payload` | String concatenation |

### Files to update
- `services/iflow-generator-mulesoft.js` — add `extractDataWeave()` + `convertToGroovy()`

---

## SPRINT 6 — MuleSoft Error Handling Conversion
**Goal**: Convert MuleSoft exception strategies to SAP IS exception sub-processes.

### Error handling mapping
| MuleSoft | SAP IS |
|----------|--------|
| `<catch-exception-strategy>` | Exception sub-process (error end event) |
| `<choice-exception-strategy>` | Exception sub-process with Router |
| `<rollback-exception-strategy>` | Exception sub-process + transaction rollback note |
| `<reference-exception-strategy>` | Shared exception sub-process (call) |
| Global exception strategy | iFlow-level exception sub-process |
| `when="#[exception.causedBy(X)]"` | Groovy condition in Router |

### Exception sub-process BPMN2 structure
```xml
<bpmn2:subProcess triggeredByEvent="true" isForCompensation="false">
  <bpmn2:startEvent isInterrupting="true">
    <bpmn2:errorEventDefinition/>
  </bpmn2:startEvent>
  <!-- error handling steps -->
  <bpmn2:endEvent>
    <bpmn2:errorEventDefinition/>
  </bpmn2:endEvent>
</bpmn2:subProcess>
```

---

## SPRINT 7 — TIBCO BW6 Full Conversion
**Goal**: Complete TIBCO BW6 (.bwp) → SAP IS iFlow with extracted XSLT mappings.

### BW6 activity → iFlow step mapping
| BW6 element | SAP IS step |
|-------------|-------------|
| `tibex:receiveEvent/StartEvent` | Start event (HTTP or Timer trigger) |
| `bpws:pick/onMessage` (HTTP) | HTTP sender adapter |
| `bpws:invoke` (REST binding) | HTTP receiver adapter |
| `bpws:invoke` (JDBC) | JDBC receiver adapter |
| `bpws:invoke` (SOAP) | SOAP receiver adapter |
| `tibex:extActivity type=bw.jdbc.*` | JDBC receiver adapter |
| `tibex:extActivity type=bw.generalactivities.log` | Log step |
| `tibex:extActivity type=bw.generalactivities.callprocess` | Process call step |
| `bpws:assign` | Content Modifier |
| `bpws:reply` | Response (end event with reply) |
| `bpws:throw` | Error end event |
| `bpws:faultHandlers/catch` | Exception sub-process |
| `bpws:scope` | Sub-process or inline sequence |
| `tibex:inputBinding` (XSLT) | **XSLT mapping step** (native, real content!) |

### XSLT extraction from BW6
The XSLT is stored as HTML-escaped XML in `expression` attribute:
```xml
expression="&lt;?xml version=&quot;1.0&quot;?&gt;&lt;xsl:stylesheet..."
```
Steps:
1. Read `expression` attribute value
2. Unescape HTML entities: `&lt;` → `<`, `&gt;` → `>`, `&quot;` → `"`
3. Result is valid XSLT 1.0 — embed directly in iFlow XSLT mapping step
4. SAP IS supports XSLT 1.0 natively — **zero translation needed**

### Link graph linearisation
BW6 `<bpws:flow>` uses explicit link dependencies. Algorithm:
1. Build adjacency list from `<bpws:link>` elements
2. Topological sort to get execution order
3. Map to linear SAP IS step sequence
4. Parallel branches (multiple targets from one link source) → Multicast step

### Files to create
- `services/iflow-generator-tibco.js`

---

## SPRINT 8 — TIBCO BW5 Conversion
**Goal**: ProcessDef (.process) XML → SAP IS iFlow.

### BW5 activity → iFlow step mapping
| BW5 element | SAP IS step |
|-------------|-------------|
| `pd:starter` (HTTP) | HTTP sender |
| `pd:starter` (JMS) | JMS sender |
| `pd:starter` (File/SFTP) | SFTP sender |
| `pd:starter` (Timer) | Timer start |
| JDBC activity | JDBC receiver |
| HTTP activity | HTTP receiver |
| JMS activity | JMS receiver |
| SMTP activity | Mail receiver |
| SFTP/FTP activity | SFTP receiver |
| Mapper/XSLT activity | XSLT or Groovy mapping |
| JavaCode activity | Groovy script (preserve Java) |
| SubProcess activity | Process call |
| Group (catch) | Exception sub-process |
| Log activity | Log step |

### Shared resource handling
`.alias` files define JDBC/JMS/HTTP connections. Extract these as externalized properties in the iFlow `parameters.prop` file.

---

## SPRINT 9 — Boomi Enhancement
**Goal**: Update Boomi parser to store raw XML + build Boomi → iFlow generator.

### Boomi component XML structure
- Boomi uses component XML: `<GenericConnectorDescriptor>`, `<ProcessRoute>`, `<BranchRoute>`
- Shapes: Start, End, Connector, Map, Decision, Return, Stop, Branch, Flow Control
- Maps stored as `.xml` with `<MapFunction>` elements

### Boomi → iFlow mapping
| Boomi shape | SAP IS step |
|-------------|-------------|
| Start (HTTP) | HTTP sender |
| Connector (HTTP Client) | HTTP receiver |
| Connector (Database) | JDBC receiver |
| Connector (Disk) | SFTP receiver |
| Connector (SFTP) | SFTP receiver |
| Connector (JMS) | JMS receiver |
| Connector (Salesforce) | Salesforce adapter |
| Connector (SAP) | IDoc/RFC adapter |
| Map | XSLT mapping (if map XML available) |
| Decision | Router |
| Branch | Multicast |
| Flow Control | Scatter-Gather |
| Return | Reply step |
| Stop | Error end event |

---

## SPRINT 10 — Conversion Quality Engine
**Goal**: Score each generated iFlow for completeness and flag manual work needed.

### Completeness scoring
```
conversionScore = (mappedSteps / totalSteps) * 100
```

### Flag categories
| Flag | Condition | Suggestion |
|------|-----------|------------|
| `UNMAPPED_CONNECTOR` | MongoDB, LDAP, CMIS, AMQP | Use HTTPS REST API alternative |
| `SCRIPTING_PRESERVED` | DataWeave/Java code in Groovy stub | Developer must implement logic |
| `MANUAL_XSLT` | Complex XSLT with custom functions | Test XSLT in IS sandbox |
| `MULTI_FLOW_SPLIT` | APIKit detected | Generated N iFlows — review each |
| `TRANSACTION_SCOPE` | Transactional element | SAP IS has limited XA transaction support |
| `BATCH_JOB` | batch:job detected | Review batch chunk processing in IS |
| `SCATTER_GATHER` | scatter-gather | Review parallel step in IS |
| `WEBSPHERE_MQ` | WMQ connector | Use JMS or AMQP adapter |

### DB fields
`artifacts.conversion_notes` JSONB array stores flags:
```json
[
  { "type": "UNMAPPED_CONNECTOR", "element": "mongo:find-objects", "suggestion": "Use HTTPS adapter with MongoDB Atlas REST API" },
  { "type": "SCRIPTING_PRESERVED", "element": "dw:transform-message", "script": "%dw 1.0\n..." }
]
```

### Readiness update after conversion
- 100% mapped, no scripting → `Auto` (green)
- 80-99% or scripting stubs → `Partial` (amber)
- <80% or unmapped connectors → `Manual` (red)

---

## SPRINT 11 — UI Conversion Pipeline
**Goal**: Surface real conversion results in the frontend — not just a download button.

### New UI elements

**Artifact detail panel additions:**
- Conversion status badge: `Not Started` | `Converting...` | `Complete` | `Needs Review`
- Conversion completeness bar: e.g., `87% automated`
- Flags section: collapsible list of conversion notes with suggestions
- "View Generated iFlow" button → opens modal with BPMN2 XML preview
- "Download iFlow Package" → downloads real .zip
- "View Source Script" → shows extracted DataWeave / XSLT

**Project-level conversion dashboard:**
- New tab: "Conversion" alongside Assessment
- Stats: X ready to auto-convert, Y partial, Z manual
- Bulk convert button: "Convert all Auto artifacts"
- Progress tracking during bulk conversion

**Conversion report modal:**
```
iFlow: scatter-gatherFlow
━━━━━━━━━━━━━━━━━━━━━━━
Steps generated:      8 / 9
Connectors mapped:    HTTP ✓, SMTP ✓
Transformations:      1 DataWeave → Groovy stub ⚠
Error handling:       catch-exception-strategy → exception sub-process ✓
Flags:                1 scripting stub needs developer review
Completeness:         89%
```

---

## SPRINT 12 — MuleSoft 4 Support
**Goal**: Handle Mule 4 namespace differences (DataWeave 2.0 syntax, new connector names).

### Mule 4 differences from Mule 3
| Aspect | Mule 3 | Mule 4 |
|--------|--------|--------|
| Namespace | `http://www.mulesoft.org/schema/mule/core` | same |
| DataWeave | `dw:transform-message` (DW 1.0) | `ee:transform` (DW 2.0) |
| DW version | `%dw 1.0` | `%dw 2.0` |
| HTTP connector | `http:listener` / `http:request` | same names, different namespace |
| Error handling | `catch-exception-strategy` | `error-handler` + `on-error-propagate` |
| Flow variables | `flowVars.x` | `vars.x` |
| Payload set | `set-payload` | `set-payload` (same) |
| DB connector | `db:select` | `db:select` (Mule 4 DB connector) |
| Object store | `objectstore:*` | `os:*` |

### DW 2.0 differences
- `%dw 2.0` header (no `%` needed for output: `output application/json`)
- `fun` keyword for custom functions
- `import` for module imports
- Pattern matching with `match`

---

## SPRINT 13 — SAP PI/PO Migration
**Goal**: Parse SAP PI/PO exported ESR/ID objects and generate modernised SAP IS iFlows.

### PI/PO export formats
- ESR (Enterprise Services Repository): `.zip` containing `*.xsd`, `*.wsdl`, `*.javaMapping`
- ID (Integration Directory): `.zip` containing `ICO.xml` (Integration Configuration Object)

### ICO.xml key elements
- `SenderComponent`, `ReceiverComponent`
- `SenderInterface`, `ReceiverInterface`
- `MappingProgram` → reference to message mapping
- `ReceiverRule` → routing conditions

### Modernisation rules
| PI/PO element | SAP IS target |
|--------------|---------------|
| RFC/IDoc sender | IDoc/RFC sender adapter |
| SOAP sender | HTTP sender adapter |
| File sender | SFTP sender adapter |
| Message mapping (Java) | Groovy script step |
| Graphical mapping (XSLT) | XSLT mapping step |
| BPM/ccBPM | iFlow with parallel/sequential steps |
| Routing rule | Router step |
| Value mapping | Value mapping step in IS |

---

## SPRINT 14 — End-to-End Validation & Deployment
**Goal**: Full regression test, Azure deploy, SAP IS sandbox import validation.

### Test checklist
- [ ] Upload `anypoint-examples-3.8.zip` → parse → convert each flow → download iFlow zip
- [ ] Import downloaded zip into SAP IS sandbox → confirm no import errors
- [ ] Upload `bw-samples-master.zip` → parse → convert each BW6 process → download
- [ ] Import TIBCO iFlow → confirm no import errors
- [ ] Verify Groovy stubs execute without syntax errors in IS runtime
- [ ] Verify XSLT mappings run in IS mapping step
- [ ] Test conversion quality scores — spot check flags
- [ ] Test bulk convert from project dashboard
- [ ] Test "View Source Script" shows original DataWeave/XSLT
- [ ] Full Azure regression: login, upload, parse, convert, download, import

### Deploy steps
1. `npm test` — all existing tests pass
2. `git push origin main` — triggers GitHub Actions CI
3. Azure App Service auto-deploys
4. Run DB migration: `node database/migrate.js`
5. Smoke test on `is-migration-sd.azurewebsites.net`

---

## How to resume a session

At the start of any session, read this file plus `project_iflow_conversion_analysis.md`. Then check the Sprint Tracker table above for status. Pick the next PENDING sprint and start. No need to re-analyse the sample files — everything is captured here.

**Current sprint to start next**: S4 — MuleSoft Flow Structure (choice/foreach/scatter-gather → iFlow steps)
