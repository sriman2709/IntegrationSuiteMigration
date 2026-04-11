---
name: iFlow Conversion Engine — Sample Analysis
description: Deep analysis of MuleSoft 3.8 and TIBCO BW6 sample files; connector/transform/trigger patterns for real iFlow generation
type: project
---

## Base Context: Real iFlow Conversion Engine

Analysis of official sample ZIPs:
- `/Users/parisuchitha/Library/CloudStorage/OneDrive-SierraDigitalinc/projects/anypoint-examples-3.8.zip`
- `/Users/parisuchitha/Library/CloudStorage/OneDrive-SierraDigitalinc/projects/bw-samples-master.zip`

---

## MuleSoft (Anypoint 3.8 — Mule 3.x format)

### File structure
- Flows in `src/main/app/*.xml` (Mule 3) — parser already handles this path
- DataWeave files in `src/main/resources/*.dwl`
- Config in `mule-artifact.json` or `mule-deploy.properties`

### Trigger patterns
| Trigger | XML element |
|---------|-------------|
| HTTP API | `<http:listener config-ref="..." path="/..."/>` |
| Scheduler | `<poll><fixed-frequency-scheduler .../></poll>` |
| JMS/AMQP | `<jms:inbound-endpoint queue="..."/>` |
| File | `<file:inbound-endpoint path="..."/>` |
| Email | `<pop3:inbound-endpoint .../>` / `<imap:inbound-endpoint .../>` |

### Connector patterns (outbound)
- HTTP: `<http:request config-ref="..." path="..." method="GET"/>`
- JDBC: `<db:select config-ref="..." ...>` / `<db:insert .../>`
- SFTP: `<sftp:outbound-endpoint path="..." connector-ref="..."/>`
- Salesforce: `<sfdc:query .../>`, `<sfdc:create .../>`
- JMS: `<jms:outbound-endpoint queue="..."/>`
- SMTP: `<smtp:outbound-endpoint from="..." to="..."/>`
- NetSuite/Workday/MS Dynamics: connector-specific elements
- MongoDB: `<mongo:find-objects .../>`

### Transformation (DataWeave 1.0)
```xml
<dw:transform-message>
  <dw:set-payload><![CDATA[%dw 1.0
%output application/json
---
{ name: payload.firstName ++ " " ++ payload.lastName }
]]></dw:set-payload>
</dw:transform-message>
```
- DW 1.0 syntax (NOT DW 2.0) — uses `%dw 1.0`, `%output`, `%%` operators
- Also `<dw:set-variable>`, `<dw:set-property>` for side outputs
- DataWeave stored in `<dw:set-payload>` CDATA blocks inside flow XML

### Error handling
```xml
<catch-exception-strategy>
  <set-payload value="Error: #[exception.message]"/>
</catch-exception-strategy>
<choice-exception-strategy>
  <catch-exception-strategy when="#[exception.causedBy(IllegalArgumentException)]">...</catch>
</choice-exception-strategy>
```

### Flow control
- `<scatter-gather>` — parallel processing with aggregation
- `<choice>` — conditional routing  
- `<foreach>` — collection iteration
- `<enricher source="#[payload]" target="#[flowVars.x]">` — variable enrichment
- `<flow-ref name="..."/>` — sub-flow invocation
- `<batch:job>` — bulk processing

---

## TIBCO BusinessWorks 6 (BW Container Edition / BW6.x)

### File structure
- Processes: `<ModuleName>/Processes/**/*.bwp` (BPWS XML)
- Service bindings: `<ModuleName>/Resources/*.json` (swagger), `*.wsdl`
- Module config: `*.bwext`, `*.module`, `MANIFEST.MF`
- No `.process` or `.alias` files (those are BW5)

### Root XML structure
```xml
<bpws:process name="module.ProcessName"
    xmlns:bpws="http://docs.oasis-open.org/wsbpel/2.0/process/executable"
    xmlns:tibex="http://www.tibco.com/bpel/2007/extensions">
  <bpws:partnerLinks>...</bpws:partnerLinks>
  <bpws:variables>...</bpws:variables>
  <bpws:scope name="scope">
    <bpws:flow name="flow">
      <bpws:links>...</bpws:links>
      <!-- activities here -->
    </bpws:flow>
  </bpws:scope>
</bpws:process>
```

### Trigger patterns
- HTTP inbound: `<bpws:pick>` with `<bpws:onMessage partnerLink="..." operation="get">`
- Process entry: `<tibex:receiveEvent><tibex:eventSource><tibex:StartEvent/></tibex:eventSource></tibex:receiveEvent>`
- Timer: `<tibex:receiveEvent>` with timer event source

### Connector patterns (outbound)
- HTTP REST: `<bpws:invoke partnerLink="movies" operation="get">` with REST binding on partner link
  - Partner link has `<tibex:ReferenceBinding>` with `xsi:type="rest:RestReferenceBinding"`
- SOAP: `<bpws:invoke>` with SOAP binding
- JDBC: `<tibex:extActivity type="bw.jdbc.query">` or `type="bw.jdbc.execute"`
- File: `<tibex:extActivity type="bw.namespaces.tnt.plugins.file.read">`
- Log: `<tibex:activityExtension activityTypeID="bw.generalactivities.log">`
- Sub-process call: `<tibex:extActivity type="bw.generalactivities.callprocess"><tibex:CallProcess subProcessName="module.ProcessName"/>`

### Transformation (XSLT 1.0 ONLY)
All mappings are XSLT 1.0 embedded in activity `expression` attributes or `<tibex:inputBinding>`:
```xml
<bpws:invoke inputVariable="get-input" ...>
  <tibex:inputBinding expressionLanguage="urn:oasis:names:tc:wsbpel:2.0:sublang:xslt1.0">
    <?xml version="1.0"?>
    <xsl:stylesheet version="1.0" ...>
      <xsl:template match="/">
        <searchString><xsl:value-of select="$Start/searchString"/></searchString>
      </xsl:template>
    </xsl:stylesheet>
  </tibex:inputBinding>
</bpws:invoke>
```

### Error handling
- BPEL `<bpws:faultHandlers>` inside `<bpws:scope>`
- `<bpws:catch faultName="...">` blocks
- Link conditions with `tibex:linkType="ERROR"` for error branching
- No explicit exception strategy DSL

### Flow control
- `<bpws:flow>` with `<bpws:links>` — explicit link graph (DAG)
- `<bpws:pick>` — event-driven branching
- `<bpws:sequence>` — ordered steps
- `<bpws:scope>` — scoped sub-flows with own fault handlers
- Sub-process: `CallProcess` activity

---

## iFlow Conversion Mapping Table

| Source concept | MuleSoft element | TIBCO BW6 element | SAP iFlow target |
|---------------|-----------------|-------------------|-----------------|
| HTTP trigger | `http:listener` | `bpws:pick/onMessage` (REST binding) | HTTP sender adapter |
| Schedule trigger | `poll/scheduler` | Timer receiveEvent | Timer start event |
| JMS/Event trigger | `jms:inbound-endpoint` | JMS receiveEvent | JMS sender adapter |
| HTTP outbound | `http:request` | `bpws:invoke` (REST binding) | HTTP receiver adapter |
| JDBC query | `db:select` | `tibex:extActivity type=bw.jdbc.*` | JDBC receiver adapter |
| SFTP | `sftp:outbound-endpoint` | File activity | SFTP receiver adapter |
| Transformation | `dw:transform-message` (DataWeave) | `tibex:inputBinding` (XSLT) | XSLT mapping step |
| Content modifier | `set-payload`, `set-variable` | `bpws:assign` | Content Modifier step |
| Conditional | `choice` router | `bpws:flow` links with conditions | Router step |
| Parallel | `scatter-gather` | `bpws:flow` parallel links | Parallel multicast |
| Loop | `foreach` | BPEL forEach | Iterating splitter |
| Error handling | `catch-exception-strategy` | `bpws:faultHandlers/catch` | Exception sub-process |
| Sub-flow | `flow-ref` | `CallProcess` | Process call step |
| Salesforce | `sfdc:*` | (not in samples) | Salesforce adapter |

---

## Key Gaps for Real Conversion

1. **DataWeave content not stored**: Parser extracts metadata but not the actual DW script. Need to store `raw_xml` in DB to have the DW code for conversion.
2. **XSLT embedded in TIBCO**: The XSLT is base64/escaped inside attribute — need to unescape and include in iFlow mapping step.
3. **No MongoDB adapter in SAP IS**: Artifacts with MongoDB connector need manual note → suggest HTTPS/REST OData alternative.
4. **APIKit/RAML**: MuleSoft APIKit flows become individual iFlow processes per HTTP operation.
5. **DW 1.0 → Groovy**: DataWeave 1.0 syntax differs from DW 2.0; convert to Groovy script in iFlow content modifier (not native mapping).

---

## Next Build Plan (Phases)

### Phase 1 — Store Raw XML (foundation)
- Add `raw_xml TEXT` column to `artifacts` table
- Store full flow XML string during parse (MuleSoft) + full .bwp content (TIBCO)
- This enables real conversion later

### Phase 2 — Real MuleSoft → iFlow
- Build `services/iflow-generator-mulesoft.js`
- Parse stored raw_xml: extract DataWeave scripts, connector configs, flow structure
- Generate valid SAP IS BPMN2 iFlow XML using real connector names and DW→Groovy transform stubs
- Package as importable .zip

### Phase 3 — Real TIBCO BW6 → iFlow
- Build `services/iflow-generator-tibco.js`
- Parse stored raw_xml: extract XSLT mappings, partner link bindings, activity sequence
- Map BW6 activities → iFlow steps; embed extracted XSLT in mapping step
- Package as importable .zip

### Phase 4 — Conversion Quality Score
- After conversion: run validation pass — flag unmapped connectors (MongoDB, LDAP, CMIS)
- Update readiness: 'Auto' if all connectors mapped, 'Partial' if any unmapped, 'Manual' if scripting
- Show conversion report in UI with what was real vs placeholder

**Why:** User wants real iFlow generation from actual source files, not reconstructed metadata stubs. The raw XML must be stored at parse time — without it, the converter has no source material.
