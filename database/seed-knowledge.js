'use strict';
/**
 * Knowledge Base Seeder
 * Pre-loads the knowledge_base table with connector mappings, conversion patterns,
 * and platform notes derived from analysis of official MuleSoft 3.8 and TIBCO BW6 samples.
 *
 * Run: node database/seed-knowledge.js
 * Safe to run multiple times — uses UPSERT on (category, title).
 */

require('dotenv').config();
const { pool } = require('./db');

const ENTRIES = [

  // ── MULESOFT CONNECTOR MAPPINGS ────────────────────────────────────────────
  {
    category: 'connector_mapping', platform: 'mulesoft',
    title: 'http:listener → HTTP Sender Adapter',
    tags: ['http', 'trigger', 'api', 'sprint3'],
    content: `Source: <http:listener config-ref="..." path="/path" doc:name="..."/>
Target: SAP IS HTTP Sender Adapter
Direction: Inbound (sender)
Config params: address (path), auth type, CSRF protection
Notes: Path becomes param.sender.address in parameters.prop. Use BasicAuthentication or ClientCertificate.
APIKit special case: if <apikit:router> is present, each flow-mapping becomes a separate iFlow.`
  },
  {
    category: 'connector_mapping', platform: 'mulesoft',
    title: 'http:request → HTTP Receiver Adapter',
    tags: ['http', 'outbound', 'sprint3'],
    content: `Source: <http:request config-ref="..." path="..." method="GET|POST" doc:name="..."/>
Target: SAP IS HTTP Receiver Adapter
Direction: Outbound (receiver)
Config params: host, port, path, method, auth type
Extraction from raw_xml: look for <http:request-config> element for host/port, <http:request> for path/method.
Auth: if <http:basic-security-filter> present → BasicAuthentication; OAuth2 → OAuth2ClientCredentials`
  },
  {
    category: 'connector_mapping', platform: 'mulesoft',
    title: 'db:select / db:insert / db:update → JDBC Receiver Adapter',
    tags: ['jdbc', 'database', 'sprint3'],
    content: `Source: <db:select config-ref="..." doc:name="..."><db:parameterized-query>SELECT...</db:parameterized-query></db:select>
Target: SAP IS JDBC Receiver Adapter
Direction: Outbound (receiver)
Extraction: <db:mysql-config> or <db:generic-config> has URL, driver, user/password.
SQL query in <db:parameterized-query> CDATA → preserve in iFlow JDBC step.
param.receiver.jdbc.datasource={{JDBC_DATASOURCE_ALIAS}} in parameters.prop`
  },
  {
    category: 'connector_mapping', platform: 'mulesoft',
    title: 'jms:inbound-endpoint → JMS Sender Adapter',
    tags: ['jms', 'trigger', 'event', 'sprint3'],
    content: `Source: <jms:inbound-endpoint queue="queueName" connector-ref="..."/>
Target: SAP IS JMS Sender Adapter
Direction: Inbound (sender) — triggers iFlow when message arrives
Trigger type → Event
Config: connection factory, queue/topic name, credential alias
param.jms.queue.name={{JMS_QUEUE_NAME}}`
  },
  {
    category: 'connector_mapping', platform: 'mulesoft',
    title: 'jms:outbound-endpoint → JMS Receiver Adapter',
    tags: ['jms', 'outbound', 'sprint3'],
    content: `Source: <jms:outbound-endpoint queue="queueName" connector-ref="..."/>
Target: SAP IS JMS Receiver Adapter
Direction: Outbound (receiver)
Config: connection factory, queue/topic name, message type`
  },
  {
    category: 'connector_mapping', platform: 'mulesoft',
    title: 'sftp:outbound-endpoint → SFTP Receiver Adapter',
    tags: ['sftp', 'file', 'outbound', 'sprint3'],
    content: `Source: <sftp:outbound-endpoint path="..." host="..." port="22" connector-ref="..."/>
Target: SAP IS SFTP Receiver Adapter
Direction: Outbound (receiver)
Config: host, port, directory, filename expression, credential alias
Extraction: look for <sftp:connector> for host/port defaults`
  },
  {
    category: 'connector_mapping', platform: 'mulesoft',
    title: 'sftp:inbound-endpoint → SFTP Sender Adapter',
    tags: ['sftp', 'file', 'trigger', 'listener', 'sprint3'],
    content: `Source: <sftp:inbound-endpoint path="..." host="..." pollingFrequency="1000"/>
Target: SAP IS SFTP Sender Adapter (polling)
Direction: Inbound (sender) — polls directory for new files
Trigger type → Listener
Config: host, port, directory, filename pattern, poll interval`
  },
  {
    category: 'connector_mapping', platform: 'mulesoft',
    title: 'sfdc:* (Salesforce) → Salesforce Receiver Adapter',
    tags: ['salesforce', 'crm', 'sprint3'],
    content: `Source: <sfdc:query .../>, <sfdc:create .../>, <sfdc:update .../>, <sfdc:upsert .../>
Target: SAP IS Salesforce Receiver Adapter
Direction: Outbound (receiver)
Config: Salesforce instance URL, OAuth credential alias, object name, operation
Extraction: <sfdc:config> has username, securityToken, url
param.receiver.salesforce.address=https://{{SF_INSTANCE}}.salesforce.com`
  },
  {
    category: 'connector_mapping', platform: 'mulesoft',
    title: 'sap:outbound-endpoint → IDoc/RFC Adapter',
    tags: ['sap', 'idoc', 'rfc', 'sprint3'],
    content: `Source: <sap:outbound-endpoint type="function|idoc" functionName="..." connector-ref="..."/>
Target: SAP IS IDoc Receiver or RFC Receiver Adapter
Direction: Outbound (receiver)
If type=function → RFC Receiver; if type=idoc → IDoc Receiver
Config: SAP host, system number, client, credential alias
param.receiver.sap.rfc.host={{SAP_HOST}}`
  },
  {
    category: 'connector_mapping', platform: 'mulesoft',
    title: 'smtp:outbound-endpoint → Mail Receiver Adapter',
    tags: ['smtp', 'email', 'mail', 'sprint3'],
    content: `Source: <smtp:outbound-endpoint from="..." to="..." subject="..." host="..." port="587"/>
Target: SAP IS Mail Receiver Adapter
Direction: Outbound (receiver)
Extraction: from/to/subject/host/port from element attributes or connector config
param.receiver.mail.host={{SMTP_HOST}}`
  },
  {
    category: 'connector_mapping', platform: 'mulesoft',
    title: 'mongo:* → NO NATIVE ADAPTER (manual flag)',
    tags: ['mongodb', 'unmapped', 'manual', 'sprint3'],
    content: `Source: <mongo:find-objects .../>, <mongo:insert-document .../> etc.
Target: NO native MongoDB adapter in SAP IS
Conversion flag: UNMAPPED_CONNECTOR
Suggestion: Use HTTPS Receiver Adapter calling MongoDB Atlas REST API (https://data.mongodb-api.com/app/data-/endpoint/data/v1/action/find)
Or: use JDBC adapter if connecting to MongoDB via JDBC bridge
Note in conversion_notes: { type: "UNMAPPED_CONNECTOR", element: "mongo:find-objects", suggestion: "Use MongoDB Atlas Data API via HTTPS adapter" }`
  },
  {
    category: 'connector_mapping', platform: 'mulesoft',
    title: 'cxf:jaxws-client / web-service-consumer → SOAP Receiver Adapter',
    tags: ['soap', 'wsdl', 'webservice', 'sprint3'],
    content: `Source: <cxf:jaxws-client operation="..." serviceClass="..." wsdlLocation="..."/>
Or: <web-service-consumer config-ref="..." operation="..."/>
Target: SAP IS SOAP Receiver Adapter
Direction: Outbound (receiver)
Config: WSDL URL, operation, auth
Extraction: <web-service-consumer:config wsdlLocation="..."> for WSDL URL`
  },
  {
    category: 'connector_mapping', platform: 'mulesoft',
    title: 'poll/scheduler → Timer Start Event',
    tags: ['scheduler', 'timer', 'trigger', 'sprint3'],
    content: `Source: <poll><fixed-frequency-scheduler frequency="60000" timeUnit="MILLISECONDS"/></poll>
Or Mule 4: <scheduler><scheduling-strategy><fixed-frequency frequency="60" timeUnit="SECONDS"/></scheduling-strategy></scheduler>
Target: SAP IS Timer Start Event
Trigger type → Schedule
Config: extract frequency and timeUnit; convert to cron expression
param.scheduler.cron=0 0 * * * (default daily — developer updates)`
  },

  // ── MULESOFT FLOW STRUCTURE ────────────────────────────────────────────────
  {
    category: 'conversion_pattern', platform: 'mulesoft',
    title: 'choice router → SAP IS Router step',
    tags: ['routing', 'conditional', 'sprint4'],
    content: `Source: <choice><when expression="#[...]">...</when><otherwise>...</otherwise></choice>
Target: SAP IS Router step with route conditions
Extraction: pull each <when expression="..."> — convert MEL expression to XPath or Groovy condition
MEL to Groovy: "#[payload.status == 'A']" → "message.getProperty('status').equals('A')"
Default route: <otherwise> maps to the "else" route in IS Router
Multiple <when> blocks → multiple routes in IS Router`
  },
  {
    category: 'conversion_pattern', platform: 'mulesoft',
    title: 'scatter-gather → SAP IS Parallel Multicast',
    tags: ['parallel', 'multicast', 'aggregation', 'sprint4'],
    content: `Source: <scatter-gather><custom-aggregation-strategy .../><branch1>...</branch1><branch2>...</branch2></scatter-gather>
Target: SAP IS Parallel Multicast step followed by Gather step
Note: if <custom-aggregation-strategy class="..."> is present → flag as SCRIPTING_PRESERVED (Java class must be reimplemented in Groovy)
Simple scatter-gather without custom strategy → fully auto-convertible
Conversion flag if custom aggregation: { type: "SCRIPTING_PRESERVED", element: "custom-aggregation-strategy" }`
  },
  {
    category: 'conversion_pattern', platform: 'mulesoft',
    title: 'foreach → SAP IS Iterating Splitter + Gather',
    tags: ['loop', 'foreach', 'iteration', 'sprint4'],
    content: `Source: <foreach collection="#[payload]" doc:name="For Each"><...steps...></foreach>
Target: Iterating Splitter → [processing steps] → Gather
Config: collection expression → Xpath/Groovy expression for IS splitter
Counter variable: foreach counter → IS exchange property
batch size attribute → chunk size in IS splitter`
  },
  {
    category: 'conversion_pattern', platform: 'mulesoft',
    title: 'enricher → SAP IS Content Enricher',
    tags: ['enricher', 'variable', 'sprint4'],
    content: `Source: <enricher source="#[payload]" target="#[flowVars.x]"><flow-ref name="lookupFlow"/></enricher>
Target: SAP IS Content Enricher step
Config: target variable name from target attribute (strip "#[flowVars." prefix)
Sub-flow call → Request-Reply to local iFlow process`
  },
  {
    category: 'conversion_pattern', platform: 'mulesoft',
    title: 'flow-ref → SAP IS Process Direct / Local Process Call',
    tags: ['subflow', 'processref', 'sprint4'],
    content: `Source: <flow-ref name="someSubFlow" doc:name="..."/>
Target: SAP IS Process Direct Receiver (for sub-process call)
Each referenced sub-flow becomes a separate iFlow with a Process Direct sender
Or: inline the sub-flow steps if it's small (< 3 steps)`
  },
  {
    category: 'conversion_pattern', platform: 'mulesoft',
    title: 'set-payload / set-variable → SAP IS Content Modifier',
    tags: ['contentmodifier', 'payload', 'variable', 'sprint4'],
    content: `Source: <set-payload value="#[...]" doc:name="..."/>
Or: <set-variable variableName="x" value="#[...]" doc:name="..."/>
Target: SAP IS Content Modifier step
set-payload → sets message body
set-variable → sets exchange property (name = variableName attr value)
MEL expression in value: strip #[ ] and translate to Groovy`
  },
  {
    category: 'conversion_pattern', platform: 'mulesoft',
    title: 'apikit:router → Multiple iFlows (one per HTTP operation)',
    tags: ['apikit', 'raml', 'rest', 'sprint4'],
    content: `Source: <apikit:config> with multiple <apikit:flow-mapping> entries
Pattern: APIKit generates one flow per resource+method combo
Target: One SAP IS iFlow per flow-mapping
Naming: {originalFlowName}_{method}_{resource_path_cleaned}
e.g. "leagues_GET_teams", "leagues_POST_teams", "leagues_GET_teams_teamId"
All share the same base HTTP sender adapter configuration
Exception mappings → Router in exception sub-process`
  },

  // ── MULESOFT TRANSFORMATION ────────────────────────────────────────────────
  {
    category: 'transformation_rule', platform: 'mulesoft',
    title: 'DataWeave 1.0 extraction from raw_xml',
    tags: ['dataweave', 'transform', 'sprint5'],
    content: `DataWeave 1.0 scripts are in <dw:transform-message> CDATA blocks.
Extraction pattern from raw_xml:
  - Find all <dw:transform-message> elements
  - Extract <dw:set-payload> CDATA → main transform body
  - Extract <dw:set-variable variableName="x"> CDATA → side outputs (exchange properties)
  - Extract <dw:set-property propertyName="x"> CDATA → header outputs
Header: starts with "%dw 1.0" and "%output application/json|csv|xml|java"
Target: SAP IS Groovy Script step with original DW preserved as comment
Important: DW 1.0 uses %dw prefix — different from DW 2.0 which uses just "dw 2.0"`
  },
  {
    category: 'transformation_rule', platform: 'mulesoft',
    title: 'DataWeave 1.0 common patterns → Groovy equivalents',
    tags: ['dataweave', 'groovy', 'sprint5'],
    content: `DW 1.0 → Groovy conversion rules:
payload.field           → body.field (with JsonSlurper)
payload map { x: $.y }  → body.collect { [x: it.y] }
payload filter $.active → body.findAll { it.active }
payload ++ " " ++ x     → body + " " + x  (string concat)
%output application/json → message.setBody(groovy.json.JsonOutput.toJson(result))
%output application/csv  → manual CSV output with StringBuilder
flowVars.x              → message.getProperty("x")
message.inboundProperties["http.query.params"].name → message.getHeader("name")`
  },

  // ── MULESOFT ERROR HANDLING ────────────────────────────────────────────────
  {
    category: 'conversion_pattern', platform: 'mulesoft',
    title: 'catch-exception-strategy → Exception Sub-process',
    tags: ['errorhandling', 'exception', 'sprint6'],
    content: `Source: <catch-exception-strategy doc:name="..."><set-payload value="Error..."/></catch-exception-strategy>
Target: SAP IS Exception Sub-process (Error Start Event → steps → Error End Event)
Structure in BPMN2:
  <bpmn2:subProcess triggeredByEvent="true">
    <bpmn2:startEvent isInterrupting="true">
      <bpmn2:errorEventDefinition/>
    </bpmn2:startEvent>
    [Content Modifier with error message]
    <bpmn2:endEvent><bpmn2:errorEventDefinition/></bpmn2:endEvent>
  </bpmn2:subProcess>`
  },
  {
    category: 'conversion_pattern', platform: 'mulesoft',
    title: 'choice-exception-strategy → Exception Sub-process with Router',
    tags: ['errorhandling', 'exception', 'routing', 'sprint6'],
    content: `Source: <choice-exception-strategy>
  <catch-exception-strategy when="#[exception.causedBy(IllegalArgumentException)]">...</catch>
  <catch-exception-strategy when="#[exception.causedBy(NullPointerException)]">...</catch>
</choice-exception-strategy>
Target: Exception Sub-process → Router
Each <when expression="..."> → Router route condition (Groovy)
exception.causedBy(X) → check exception class in Groovy: exception.class.simpleName == "X"
Always add a default (otherwise) route for unhandled exceptions`
  },

  // ── TIBCO BW6 CONNECTOR MAPPINGS ──────────────────────────────────────────
  {
    category: 'connector_mapping', platform: 'tibco',
    title: 'bpws:pick/onMessage (REST binding) → HTTP Sender Adapter',
    tags: ['http', 'trigger', 'bw6', 'sprint7'],
    content: `Source: <bpws:pick createInstance="yes">
  <bpws:onMessage operation="get" partnerLink="movies" portType="ns0:movies" variable="get">
Target: SAP IS HTTP Sender Adapter
Trigger type → API
Extract: partnerLink name gives service name; operation gives HTTP method
Partner link has RestServiceBinding with basePath and path
Use swagger.json reference if present for full API spec`
  },
  {
    category: 'connector_mapping', platform: 'tibco',
    title: 'bpws:invoke (REST binding) → HTTP Receiver Adapter',
    tags: ['http', 'outbound', 'bw6', 'sprint7'],
    content: `Source: <bpws:invoke inputVariable="get-input" name="get" operation="get" outputVariable="get" partnerLink="movies">
  <tibex:inputBinding expressionLanguage="...">XSLT mapping</tibex:inputBinding>
Target: SAP IS HTTP Receiver Adapter
Extract: partnerLink binding has host (HttpClientResource), path, method from operation
inputBinding XSLT → XSLT Mapping step before the HTTP call
outputVariable → response stored in exchange property`
  },
  {
    category: 'connector_mapping', platform: 'tibco',
    title: 'tibex:extActivity type=bw.jdbc.* → JDBC Receiver Adapter',
    tags: ['jdbc', 'database', 'bw6', 'sprint7'],
    content: `Source: <tibex:extActivity type="bw.jdbc.query" inputVariable="..." outputVariable="...">
Target: SAP IS JDBC Receiver Adapter
Direction: Outbound (receiver)
SQL query stored in activityConfig properties — extract from tibex:config
JDBC connection resource referenced by JDBCSharedResource — extract from module bindings`
  },
  {
    category: 'transformation_rule', platform: 'tibco',
    title: 'XSLT extraction from tibex:inputBinding in BW6',
    tags: ['xslt', 'transform', 'bw6', 'sprint7'],
    content: `BW6 stores ALL data mappings as XSLT 1.0 in the "expression" attribute of activities.
Extraction steps:
1. Read expression attribute value (HTML-escaped)
2. Unescape: &lt; → <, &gt; → >, &quot; → ", &amp; → &
3. Result is valid XSLT 1.0 stylesheet
4. SAP IS supports XSLT 1.0 natively — embed directly in XSLT Mapping step
5. No translation needed — this is 100% auto-convertible

XSLT mapping step in IS iFlow BPMN2:
<bpmn2:serviceTask name="Map Data">
  <bpmn2:extensionElements>
    <ifl:property key="activityType" value="TransformationMapping"/>
    <ifl:property key="mappingType" value="XSLT"/>
    <ifl:property key="xslMapping" value="mapping/{filename}.xsl"/>
  </bpmn2:extensionElements>
</bpmn2:serviceTask>
Store the extracted XSLT in src/main/resources/mapping/{flowName}_{activityName}.xsl`
  },
  {
    category: 'conversion_pattern', platform: 'tibco',
    title: 'BW6 bpws:flow link graph → linear iFlow step sequence',
    tags: ['flowstructure', 'linkgraph', 'bw6', 'sprint7'],
    content: `BW6 uses explicit link dependencies in <bpws:flow><bpws:links> rather than sequential steps.
Linearisation algorithm:
1. Build adjacency list: link.name → {source activity, target activity}
2. Topological sort of activities using Kahn's algorithm
3. Map sorted list to sequential SAP IS steps
Parallel branches: if one activity has multiple outgoing links → Multicast step
Join points: multiple incoming links to same activity → Gather step
Error links (tibex:linkType="ERROR") → branch to exception sub-process`
  },
  {
    category: 'conversion_pattern', platform: 'tibco',
    title: 'tibex:extActivity type=bw.generalactivities.callprocess → Process Call',
    tags: ['subprocess', 'callprocess', 'bw6', 'sprint7'],
    content: `Source: <tibex:extActivity type="bw.generalactivities.callprocess">
  <tibex:CallProcess subProcessName="module.ProcessName"/>
</tibex:extActivity>
Target: SAP IS Process Direct call to separate iFlow
The sub-process name gives the target iFlow name
Map module.ProcessName → IS iFlow named {ProcessName} (last segment of dotted name)`
  },

  // ── PLATFORM NOTES ────────────────────────────────────────────────────────
  {
    category: 'platform_note', platform: 'mulesoft',
    title: 'MuleSoft 3.8 vs Mule 4 key differences',
    tags: ['mule3', 'mule4', 'sprint12'],
    content: `Mule 3.8 (anypoint-examples):
- DataWeave 1.0: uses %dw 1.0, %output, %% operators
- Transform element: <dw:transform-message>
- Error handling: <catch-exception-strategy>, <choice-exception-strategy>
- Flow variables: flowVars.x
- HTTP: <http:listener>, <http:request>
- DB: <db:select>, <db:insert>

Mule 4:
- DataWeave 2.0: uses %dw 2.0, output (no %)
- Transform element: <ee:transform>
- Error handling: <error-handler><on-error-propagate>
- Flow variables: vars.x
- HTTP: same names but different namespace
- DB: same names, updated connector

Detection: check root <mule> version attribute or xmlns for ee namespace (Mule 4)`
  },
  {
    category: 'platform_note', platform: 'tibco',
    title: 'TIBCO BW5 vs BW6 detection and differences',
    tags: ['bw5', 'bw6', 'detection'],
    content: `BW5 detection: ZIP contains .process files → use BW5 parser (ProcessDef format)
BW6 detection: ZIP contains .bwp files → use BW6 parser (BPWS/BPEL format)

BW5 key facts:
- Root element: <pd:ProcessDef xmlns:pd="http://www.tibco.com/process/2003/BasicDefs">
- Activities in <pd:activity> elements with xsi:type attributes
- Shared resources in .alias files
- Mapper = XSLT stored in separate .xsl files or inline pd:xpath elements

BW6 key facts:
- Root: <bpws:process> (BPELS 2.0 standard)
- TIBCO extensions under tibex: namespace
- ALL mappings are XSLT 1.0 in activity expression attributes (HTML-escaped)
- Link-graph flow model (DAG) not sequential
- Sub-processes via CallProcess activity
- Service bindings via partnerLinks with RestReferenceBinding or SOAPBinding`
  },
  {
    category: 'platform_note', platform: 'all',
    title: 'SAP IS iFlow ZIP structure — importable package format',
    tags: ['iflow', 'structure', 'sprint2'],
    content: `Valid SAP IS importable .zip structure:
  META-INF/MANIFEST.MF
  src/main/resources/
    scenarioflows/integrationflow/{iflowId}.iflw   ← BPMN2 XML (main file)
    parameters.prop                                  ← externalized params
    mapping/{name}.xsl or {name}.mmap               ← XSLT or message mappings
    script/{name}.groovy                             ← Groovy scripts

MANIFEST.MF required fields:
  Bundle-SymbolicName: {iflowId}
  Bundle-Name: {iflowName}
  Bundle-Version: 1.0.0
  artifact-type: IFlow

iflowId rules: lowercase, hyphen-separated, no spaces
Naming: {domain}_{platformAbbrev}_{artifactName} e.g. "int-mule-scattergather"
Package: one .zip = one iFlow (not a package of multiple iFlows)`
  },
  {
    category: 'edge_case', platform: 'mulesoft',
    title: 'MuleSoft ZIP containing single JAR — recursive extraction',
    tags: ['jar', 'upload', 'parsing'],
    content: `Issue: User uploads a .zip that contains only one .jar file inside it (common Anypoint export pattern).
Solution (already implemented in mulesoft-service.js):
  1. Detect single non-directory entry that ends in .jar
  2. Extract JAR to temp file (zipPath + "_inner.jar")
  3. Recurse parseProjectZip(tmpJar)
  4. Cleanup temp file after
This handles the "importing-a-CSV-file-into-Mongo-DB-2.1.4-mule-application-example.jar" pattern.`
  },
  {
    category: 'edge_case', platform: 'all',
    title: 'Mock vs Real data detection in uploaded artifacts',
    tags: ['mock', 'real', 'fallback', 'upload'],
    content: `After upload, artifact.raw_metadata.source === "fallback" means parser found no flows.
Causes:
  - MuleSoft: XML found but no <flow> elements (e.g. config-only file)
  - TIBCO: no .process or .bwp files found in ZIP
  - All: ZIP structure unexpected
Frontend shows: green "✓ Real data" or amber "⚠ Mock data" banner based on this flag.
If raw_xml IS NOT NULL → definitely real data was parsed.
Improvement: after S1, check raw_xml IS NOT NULL for definitive real data confirmation.`
  },
  {
    category: 'sprint_decision', platform: 'all',
    title: 'Sprint plan summary — IS Migration Accelerator (S0-S14)',
    tags: ['sprints', 'plan', 'overview'],
    content: `S0: Knowledge Base (this table) + MCP server — DONE
S1: raw_xml column in artifacts + all parsers store source XML — DONE
S2: iFlow package engine (engine/iflow.js) — DONE (exists, stubs only)
S3: MuleSoft connector mapping (real adapters from raw_xml)
S4: MuleSoft flow structure (choice/foreach/scatter-gather → IS steps)
S5: MuleSoft transformation (DataWeave 1.0 → Groovy stubs)
S6: MuleSoft error handling (exception strategies → IS exception sub-process)
S7: TIBCO BW6 full conversion (XSLT extraction, link graph linearisation)
S8: TIBCO BW5 conversion
S9: Boomi enhancement (raw_xml + real generator)
S10: Conversion quality engine (completeness %, flags, notes)
S11: UI conversion pipeline (status, report, bulk convert)
S12: MuleSoft 4 support (Mule 4 namespaces + DW 2.0)
S13: SAP PI/PO migration
S14: End-to-end validation + Azure deploy + SAP IS sandbox import test`
  }
];

async function seedKnowledge() {
  let inserted = 0;
  let updated = 0;

  for (const entry of ENTRIES) {
    const existing = await pool.query(
      'SELECT id FROM knowledge_base WHERE category = $1 AND title = $2',
      [entry.category, entry.title]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        'UPDATE knowledge_base SET content = $1, platform = $2, tags = $3, updated_at = NOW() WHERE id = $4',
        [entry.content, entry.platform || null, entry.tags || [], existing.rows[0].id]
      );
      updated++;
    } else {
      await pool.query(
        `INSERT INTO knowledge_base (category, title, content, platform, tags, source)
         VALUES ($1, $2, $3, $4, $5, 'seed')`,
        [entry.category, entry.title, entry.content, entry.platform || null, entry.tags || []]
      );
      inserted++;
    }
  }

  console.log(`Knowledge base seeded: ${inserted} new, ${updated} updated, ${ENTRIES.length} total entries.`);
  await pool.end();
}

seedKnowledge().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
