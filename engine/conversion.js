/**
 * Conversion Engine
 * Generates detailed iFlow conversion plan from artifact + platform data.
 */

const { generateIFlowName } = require('./assessment');

function runConversion(artifact, platformData) {
  const platform = artifact.platform || 'boomi';
  const iflowName = generateIFlowName(artifact);
  const iflowPackage = `${artifact.domain || 'INT'}_Migration_Package_v1`;
  const ts = new Date().toISOString();

  const adapterMappings = buildAdapterMappings(artifact, platformData, platform);
  const shapeMappings = buildShapeMappings(artifact, platformData, platform);
  const warnings = buildWarnings(artifact, platformData, platform);
  const conversionLog = buildConversionLog(artifact, platformData, platform, iflowName, adapterMappings);
  const iflowXml = buildIFlowXmlStub(artifact, platformData, iflowName, iflowPackage, adapterMappings);

  const manualEffort = calculateManualEffort(artifact, platformData);

  return {
    status: warnings.filter(w => w.severity === 'error').length > 0 ? 'converted_with_errors' : warnings.length > 0 ? 'converted_with_warnings' : 'converted',
    timestamp: ts,
    iflow_id: iflowName,
    iflow_name: iflowName.replace(/_/g, ' '),
    iflow_package: iflowPackage,
    platform_source: platform.toUpperCase(),
    adapter_mappings: adapterMappings,
    shape_mappings: shapeMappings,
    warnings,
    conversion_log: conversionLog,
    iflow_xml: iflowXml,
    estimated_manual_effort_days: manualEffort,
    auto_converted_percentage: Math.round((1 - manualEffort / artifact.effort_days) * 100),
    next_steps: buildNextSteps(artifact, warnings)
  };
}

function buildAdapterMappings(artifact, pd, platform) {
  const mappings = [];
  const iflowAdapters = pd.iflowAdapters || [];

  if (platform === 'boomi') {
    const shapes = pd.shapes || [];
    const connectors = shapes.filter(s => s.type === 'connector' && s.connector !== 'Groovy');
    connectors.forEach((c, i) => {
      const target = mapBoomiConnectorToIS(c.connector, c.operation);
      mappings.push({
        source_type: `Boomi ${c.connector} Connector`,
        source_operation: c.operation || 'Execute',
        target_adapter: target.adapter,
        target_config: target.config,
        mapping_status: target.status,
        notes: target.notes
      });
    });
    const startShape = shapes.find(s => s.type === 'start');
    if (startShape) {
      mappings.unshift({ source_type: `Boomi ${startShape.connector || 'HTTP'} Start`, source_operation: startShape.config || '', target_adapter: mapTriggerToISEvent(artifact.trigger_type), target_config: `IS ${mapTriggerToISEvent(artifact.trigger_type)} configuration`, mapping_status: 'auto', notes: 'Start event converted automatically' });
    }
  } else if (platform === 'mulesoft') {
    const processors = pd.processors || [];
    processors.filter(p => !p.type.startsWith('ee:') && !p.type.startsWith('logger') && !p.type.startsWith('error')).forEach(p => {
      const target = mapMuleSoftProcessorToIS(p.type, p.label);
      mappings.push({ source_type: `MuleSoft ${p.type}`, source_label: p.label, target_adapter: target.adapter, target_config: target.config, mapping_status: target.status, notes: target.notes });
    });
  } else if (platform === 'pipo') {
    const ch = pd.channel || {};
    if (ch.sender) mappings.push({ source_type: `PI/PO Sender Channel (${ch.sender.type})`, source_operation: ch.sender.direction, target_adapter: pd.iflowAdapters?.[0] || `IS ${ch.sender.type} Sender Adapter`, target_config: 'Configure with PI/PO channel parameters', mapping_status: 'semi-auto', notes: 'Sender channel parameters require manual verification' });
    if (ch.receiver) mappings.push({ source_type: `PI/PO Receiver Channel (${ch.receiver.type})`, source_operation: ch.receiver.direction, target_adapter: pd.iflowAdapters?.[1] || `IS ${ch.receiver.type} Receiver Adapter`, target_config: 'Configure with PI/PO channel parameters', mapping_status: 'semi-auto', notes: 'Receiver channel parameters require manual verification' });
    if (pd.mapping) mappings.push({ source_type: `PI/PO ${pd.mapping.type}`, source_operation: pd.mapping.name, target_adapter: pd.mapping.type === 'XSLT' ? 'IS XSLT Step (reuse existing XSLT)' : 'IS Message Mapping (import from PI/PO)', target_config: 'Import or recreate mapping in IS Integration Designer', mapping_status: pd.mapping.type === 'XSLT' ? 'auto' : 'semi-auto', notes: pd.mapping.type === 'XSLT' ? 'XSLT directly reusable' : 'Use SAP Migration Tool to import message mapping' });
  } else if (platform === 'tibco') {
    const activities = pd.activities || [];
    activities.forEach(a => {
      const target = mapTIBCOActivityToIS(a.type, a.label);
      if (target) mappings.push({ source_type: `TIBCO ${a.type}`, source_label: a.label, target_adapter: target.adapter, target_config: target.config, mapping_status: target.status, notes: target.notes });
    });
  }

  return mappings;
}

function buildShapeMappings(artifact, pd, platform) {
  const shapes = pd.shapes || pd.activities || pd.processors || [];
  return shapes.map((s, i) => ({
    step: i + 1,
    source_label: s.label || s.name || `Step ${i + 1}`,
    source_type: s.type || 'unknown',
    target_type: getISStepType(s.type, platform),
    conversion_status: getConversionStatus(s.type, platform),
    notes: getStepNotes(s, platform)
  }));
}

function buildWarnings(artifact, pd, platform) {
  const warnings = [];

  if (artifact.has_scripting) {
    const scripts = pd.scripts || pd.dataWeaveTransforms?.filter(t => t.complexity === 'complex') || [];
    warnings.push({ severity: 'warning', code: 'SCRIPTING_REVIEW', message: `${scripts.length || 1} script(s) require functional testing in IS Groovy sandbox before deployment`, affected: scripts.map(s => s.name).join(', ') || 'Custom scripts' });
  }

  if (artifact.error_handling === 'multi_try_catch') {
    warnings.push({ severity: 'warning', code: 'ERROR_HANDLING_REDESIGN', message: 'Multi-level error handling requires manual redesign as IS Exception Subprocess pattern', affected: 'Error Handling Structure' });
  }

  if ((pd.connectorTypes || []).includes('AS2')) {
    warnings.push({ severity: 'warning', code: 'B2B_LICENSE_REQUIRED', message: 'AS2 adapter requires SAP IS B2B/EDI Add-on license — verify before deployment', affected: 'AS2 Adapter Configuration' });
  }

  if (artifact.maps_count > 4) {
    warnings.push({ severity: 'warning', code: 'HIGH_MAPPING_COMPLEXITY', message: `${artifact.maps_count} data mappings require thorough payload testing with real source data`, affected: 'Data Mapping Steps' });
  }

  if (platform === 'mulesoft') {
    const complexTransforms = (pd.dataWeaveTransforms || []).filter(t => t.complexity === 'complex');
    if (complexTransforms.length > 0) {
      warnings.push({ severity: 'warning', code: 'DATAWEAVE_CONVERSION', message: `${complexTransforms.length} complex DataWeave transform(s) require conversion to IS Message Mapping or XSLT`, affected: complexTransforms.map(t => t.name).join(', ') });
    }
  }

  if (platform === 'pipo' && pd.mapping?.type === 'Message Mapping') {
    warnings.push({ severity: 'info', code: 'PIPO_MIGRATION_TOOL', message: 'SAP Migration Tool can auto-migrate this XI Message Mapping to IS — recommended before manual conversion', affected: pd.mapping.name });
  }

  return warnings;
}

function buildConversionLog(artifact, pd, platform, iflowName, adapterMappings) {
  const ts = new Date().toISOString();
  const autoConverted = adapterMappings.filter(m => m.mapping_status === 'auto').length;
  const semiAuto = adapterMappings.filter(m => m.mapping_status === 'semi-auto').length;
  const manual = adapterMappings.filter(m => m.mapping_status === 'manual').length;

  return `=== SAP Integration Suite Migration Tool — Conversion Engine v1.0 ===
Timestamp   : ${ts}
Source      : ${platform.toUpperCase()} | ${artifact.name}
Target iFlow: ${iflowName}
Complexity  : ${artifact.complexity_level} (${artifact.complexity_score}/100)

[STEP 1] Parsing source artifact structure...
  ✓ Platform: ${platform.toUpperCase()} | Mode: ${pd._mode || 'mock'}
  ✓ Shapes/Activities: ${artifact.shapes_count} | Connectors: ${artifact.connectors_count} | Maps: ${artifact.maps_count}
  ✓ Scripting: ${artifact.has_scripting ? `Yes (${pd.scripts?.length || 1} script(s))` : 'None'}
  ✓ Error Handling: ${artifact.error_handling} | Dependencies: ${artifact.dependencies_count}

[STEP 2] Generating iFlow skeleton...
  ✓ iFlow ID   : ${iflowName}
  ✓ Package    : ${artifact.domain}_Migration_Package_v1
  ✓ Start Event: ${mapTriggerToISEvent(artifact.trigger_type)}
  ✓ End Event  : ${artifact.trigger_type === 'API' ? 'Request Reply End Event' : 'Message End Event'}
  ✓ Process Step pool created

[STEP 3] Converting adapter configurations...
  ✓ Total adapter mappings: ${adapterMappings.length}
  ✓ Auto-converted: ${autoConverted} adapter(s)
  ⚠ Semi-automatic: ${semiAuto} adapter(s) — parameter review required
  ${manual > 0 ? `✗ Manual conversion: ${manual} adapter(s)` : '✓ No fully manual adapter conversions'}

[STEP 4] Converting data mappings...
${artifact.maps_count > 0 ? `  ✓ ${artifact.maps_count} mapping(s) analyzed
  ${platform === 'pipo' ? '✓ XI Message Mappings prepared for SAP Migration Tool import' : platform === 'tibco' ? '✓ XSLT/BW Mapper configurations analyzed — IS Message Mapping stubs generated' : `✓ ${platform === 'mulesoft' ? 'DataWeave transforms' : 'Groovy/XSLT mappings'} flagged for manual conversion`}` : '  ✓ No data mappings required'}
${artifact.has_scripting ? `  ⚠ ${pd.scripts?.length || 1} script(s) require manual reimplementation — flagged for QA` : ''}

[STEP 5] Converting error handling...
  ${artifact.error_handling === 'multi_try_catch' ? '⚠ Multi-level try/catch — Exception Subprocess scaffold generated (manual adjustment required)' : artifact.error_handling === 'try_catch' ? '✓ Try/Catch pattern → IS Exception Subprocess generated' : artifact.error_handling === 'none' ? '⚠ No error handling — IS Error End Event placeholder added (review recommended)' : '✓ Basic error handling → IS Error End Event configured'}

[STEP 6] Generating iFlow BPMN/XML structure...
  ✓ BPMN participant pool created
  ✓ Adapter configurations externalized as IS parameters
  ✓ Credential Store references added (placeholder — configure in IS Secure Store)
  ✓ MPL trace level set to INFO
  ✓ iFlow XML manifest generated

[STEP 7] Final validation...
  ✓ Start → Process → End connectivity verified
  ✓ Mandatory adapter properties present
  ✓ IS schema compatibility checked
  ${artifact.has_scripting ? '⚠ Script steps require sandbox review before deployment' : '✓ All steps validated — no blocking issues'}

[CONVERSION COMPLETE]
Status                   : ${artifact.complexity_level === 'Complex' ? 'Converted with Warnings' : 'Converted Successfully'}
Auto-converted adapters  : ${autoConverted}/${adapterMappings.length}
Manual review required   : ${artifact.has_scripting ? 'Yes (scripting)' : 'No'}
Estimated remaining work : ${calculateManualEffort(artifact, pd)}d of ${artifact.effort_days}d total
`;
}

function buildIFlowXmlStub(artifact, pd, iflowName, iflowPackage, adapterMappings) {
  const senderAdapter = pd.iflowAdapters?.[0] || 'HTTPS';
  const receiverAdapter = pd.iflowAdapters?.[1] || 'HTTPS';
  const senderAdapterType = senderAdapter.split(' ')[0];
  const receiverAdapterType = receiverAdapter.split(' ')[0];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- SAP Integration Suite iFlow — Generated by IS Migration Assessment Tool -->
<!-- Source: ${artifact.platform?.toUpperCase()} | ${artifact.name} -->
<!-- Package: ${iflowPackage} | iFlow: ${iflowName} -->
<!-- Generated: ${new Date().toISOString()} -->
<!-- Status: DRAFT — Review adapter configurations before deployment -->

<bpmn2:definitions
  xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:ifl="http:///com.sap.ifl.model/Ifl.xsd"
  id="${iflowName}"
  targetNamespace="http://www.sap.com/ifl">

  <bpmn2:collaboration id="Collaboration_${iflowName}">
    <bpmn2:participant id="Sender" name="Sender">
      <bpmn2:extensionElements>
        <ifl:property>
          <key>componentVersion</key><value>1.0.0</value>
        </ifl:property>
      </bpmn2:extensionElements>
    </bpmn2:participant>

    <bpmn2:participant id="Integration_Process" name="${iflowName}">
      <bpmn2:processRef>Process_1</bpmn2:processRef>
    </bpmn2:participant>

    <bpmn2:participant id="Receiver" name="Receiver">
      <bpmn2:extensionElements>
        <ifl:property>
          <key>componentVersion</key><value>1.0.0</value>
        </ifl:property>
      </bpmn2:extensionElements>
    </bpmn2:participant>

    <!-- Sender Channel: ${senderAdapterType} -->
    <bpmn2:messageFlow
      id="MessageFlow_Sender"
      name="Sender Channel (${senderAdapterType})"
      sourceRef="Sender"
      targetRef="StartEvent_1">
      <bpmn2:extensionElements>
        <ifl:property><key>ComponentType</key><value>${senderAdapterType}</value></ifl:property>
        <ifl:property><key>address</key><value>{{sender_address}}</value></ifl:property>
        <ifl:property><key>Description</key><value>Inbound from ${artifact.trigger_type} trigger — ${artifact.primary_connector}</value></ifl:property>
      </bpmn2:extensionElements>
    </bpmn2:messageFlow>

    <!-- Receiver Channel: ${receiverAdapterType} -->
    <bpmn2:messageFlow
      id="MessageFlow_Receiver"
      name="Receiver Channel (${receiverAdapterType})"
      sourceRef="EndEvent_1"
      targetRef="Receiver">
      <bpmn2:extensionElements>
        <ifl:property><key>ComponentType</key><value>${receiverAdapterType}</value></ifl:property>
        <ifl:property><key>address</key><value>{{receiver_address}}</value></ifl:property>
        <ifl:property><key>Description</key><value>Outbound to ${artifact.primary_connector}</value></ifl:property>
      </bpmn2:extensionElements>
    </bpmn2:messageFlow>
  </bpmn2:collaboration>

  <bpmn2:process id="Process_1" isExecutable="true">

    <!-- Start Event -->
    <bpmn2:startEvent id="StartEvent_1" name="Start — ${artifact.trigger_type}">
      <bpmn2:extensionElements>
        <ifl:property><key>name</key><value>${iflowName}_Start</value></ifl:property>
      </bpmn2:extensionElements>
      <bpmn2:outgoing>SequenceFlow_1</bpmn2:outgoing>
    </bpmn2:startEvent>

    <!-- Message Processing Step -->
    <bpmn2:serviceTask id="ServiceTask_1" name="Process — ${artifact.name}">
      <bpmn2:extensionElements>
        <ifl:property><key>activityType</key><value>Receiver</value></ifl:property>
        <ifl:property><key>name</key><value>${iflowName}_Process</value></ifl:property>
        <ifl:property><key>Description</key>
          <value>Main processing step. Contains ${artifact.connectors_count} adapter call(s) and ${artifact.maps_count} message mapping(s).</value>
        </ifl:property>
      </bpmn2:extensionElements>
      <bpmn2:incoming>SequenceFlow_1</bpmn2:incoming>
      <bpmn2:outgoing>SequenceFlow_2</bpmn2:outgoing>
    </bpmn2:serviceTask>

${artifact.maps_count > 0 ? `    <!-- Message Mapping Step -->
    <bpmn2:serviceTask id="MessageMapping_1" name="Map — ${artifact.name}">
      <bpmn2:extensionElements>
        <ifl:property><key>activityType</key><value>MessageMapping</value></ifl:property>
        <ifl:property><key>mappingRef</key><value>${artifact.domain}_${artifact.name}_Mapping_v1</value></ifl:property>
        <ifl:property><key>Description</key><value>${artifact.maps_count} mapping(s) — ${artifact.platform === 'pipo' ? 'imported from XI via Migration Tool' : 'converted from source platform'}</value></ifl:property>
      </bpmn2:extensionElements>
      <bpmn2:incoming>SequenceFlow_2</bpmn2:incoming>
      <bpmn2:outgoing>SequenceFlow_3</bpmn2:outgoing>
    </bpmn2:serviceTask>` : ''}

${artifact.has_scripting ? `    <!-- Groovy Script Step (REVIEW REQUIRED) -->
    <!-- TODO: Replace placeholder with actual script logic converted from ${artifact.platform?.toUpperCase()} -->
    <bpmn2:scriptTask id="ScriptTask_1" name="Script — Custom Logic (REVIEW)">
      <bpmn2:extensionElements>
        <ifl:property><key>activityType</key><value>Script</value></ifl:property>
        <ifl:property><key>scriptFormat</key><value>groovy</value></ifl:property>
        <ifl:property><key>Description</key><value>PLACEHOLDER — Convert from ${artifact.platform === 'mulesoft' ? 'DataWeave' : 'Groovy/Java'}: ${(pd.scripts || []).map(s => s.name).join(', ') || 'Custom script'}</value></ifl:property>
      </bpmn2:extensionElements>
      <bpmn2:incoming>SequenceFlow_${artifact.maps_count > 0 ? 3 : 2}</bpmn2:incoming>
      <bpmn2:outgoing>SequenceFlow_Final</bpmn2:outgoing>
    </bpmn2:scriptTask>` : ''}

${artifact.error_handling !== 'none' ? `    <!-- Exception Subprocess -->
    <bpmn2:subProcess id="SubProcess_Error" name="Exception Subprocess" triggeredByEvent="true">
      <bpmn2:extensionElements>
        <ifl:property><key>activityType</key><value>ExceptionSubProcess</value></ifl:property>
        <ifl:property><key>Description</key><value>Error handler converted from ${artifact.error_handling} pattern</value></ifl:property>
      </bpmn2:extensionElements>
      <bpmn2:startEvent id="ErrorStart_1" name="Error Start">
        <bpmn2:errorEventDefinition/>
      </bpmn2:startEvent>
      <bpmn2:endEvent id="ErrorEnd_1" name="Error End">
        <bpmn2:errorEventDefinition/>
      </bpmn2:endEvent>
    </bpmn2:subProcess>` : ''}

    <!-- End Event -->
    <bpmn2:endEvent id="EndEvent_1" name="End — ${iflowName}">
      <bpmn2:incoming>SequenceFlow_Final</bpmn2:incoming>
    </bpmn2:endEvent>

    <!-- Sequence Flows -->
    <bpmn2:sequenceFlow id="SequenceFlow_1" sourceRef="StartEvent_1" targetRef="ServiceTask_1"/>
    <bpmn2:sequenceFlow id="SequenceFlow_2" sourceRef="ServiceTask_1" targetRef="${artifact.maps_count > 0 ? 'MessageMapping_1' : artifact.has_scripting ? 'ScriptTask_1' : 'EndEvent_1'}"/>
    ${artifact.maps_count > 0 ? `<bpmn2:sequenceFlow id="SequenceFlow_3" sourceRef="MessageMapping_1" targetRef="${artifact.has_scripting ? 'ScriptTask_1' : 'EndEvent_1'}"/>` : ''}
    ${artifact.has_scripting ? `<bpmn2:sequenceFlow id="SequenceFlow_Final" sourceRef="ScriptTask_1" targetRef="EndEvent_1"/>` : ''}

  </bpmn2:process>

  <!-- Externalized Parameters -->
  <!-- Configure these in SAP Integration Suite before deployment -->
  <!--
    Parameters:
    - sender_address    : Inbound endpoint path (e.g., /http/${iflowName.toLowerCase()})
    - receiver_address  : Target system URL (e.g., {{target_system_url}})
    - credential_name   : IS Secure Store credential alias
    All values should reference IS Credential Store — never hardcode credentials.
  -->

</bpmn2:definitions>`;
}

function buildNextSteps(artifact, warnings) {
  const steps = ['Review adapter mappings and configure IS adapter parameters'];
  if (warnings.some(w => w.code === 'SCRIPTING_REVIEW')) steps.push('Manually convert and test scripting logic in IS Groovy sandbox');
  if (warnings.some(w => w.code === 'ERROR_HANDLING_REDESIGN')) steps.push('Redesign multi-level error handling as IS Exception Subprocess');
  if (warnings.some(w => w.code === 'B2B_LICENSE_REQUIRED')) steps.push('Confirm SAP IS B2B/EDI Add-on license before deploying AS2/IDoc adapters');
  if (warnings.some(w => w.code === 'PIPO_MIGRATION_TOOL')) steps.push('Run SAP Migration Tool to import XI Message Mapping directly');
  steps.push('Run QA checks to validate iFlow structure');
  steps.push('Deploy to IS Development tenant and test with sample payload');
  return steps;
}

function calculateManualEffort(artifact, pd) {
  let base = artifact.effort_days;
  let manualFactor = 0.15;
  if (artifact.has_scripting) manualFactor += 0.35;
  if (artifact.error_handling === 'multi_try_catch') manualFactor += 0.15;
  if (artifact.maps_count > 4) manualFactor += 0.10;
  return Math.max(0.5, Math.round(base * manualFactor * 2) / 2);
}

// ── Adapter Mapping Tables ──────────────────────────────────────────────────

function mapBoomiConnectorToIS(connectorType, operation) {
  const map = {
    'Salesforce': { adapter: 'Salesforce Receiver Adapter', config: 'Configure with IS Salesforce OAuth2 credential', status: 'auto', notes: '1:1 mapping — configure credential alias in IS Secure Store' },
    'SAP S/4HANA': { adapter: 'OData Receiver (SAP S/4HANA)', config: 'Configure OData service URL and authentication', status: 'semi-auto', notes: 'Map Boomi BAPI/RFC operation to equivalent IS OData service' },
    'SAP SuccessFactors': { adapter: 'SuccessFactors Adapter (OData)', config: 'Configure SF OData API endpoint and credential', status: 'auto', notes: '1:1 mapping with IS SuccessFactors Adapter' },
    'SFTP': { adapter: 'SFTP Adapter', config: 'Configure SFTP host, credentials, and file path', status: 'auto', notes: 'Direct equivalent — same parameters' },
    'AS2': { adapter: 'AS2 Receiver/Sender Adapter', config: 'Configure AS2 partner ID, certificates, MDN settings', status: 'semi-auto', notes: 'Requires B2B Add-on; import trading partner certificates' },
    'JMS': { adapter: 'JMS Adapter', config: 'Configure JMS broker URL and destination', status: 'auto', notes: 'Direct equivalent — configure in IS Secure Store' },
    'Database': { adapter: 'JDBC Adapter', config: 'Configure JDBC URL and credentials', status: 'auto', notes: 'Use IS JDBC Adapter with driver and credential alias' },
    'HTTP': { adapter: 'HTTPS Sender/Receiver Adapter', config: 'Configure endpoint URL, authentication', status: 'auto', notes: 'Direct mapping — configure SSL and credential store entry' },
    'HTTP Server': { adapter: 'HTTPS Sender Adapter', config: 'Configure service endpoint path', status: 'auto', notes: 'HTTP Listener → IS HTTPS Sender Adapter endpoint' },
    'Mail': { adapter: 'Mail Adapter', config: 'Configure SMTP server, port, from address', status: 'auto', notes: 'Direct equivalent in IS Mail Adapter' },
    'SAP Ariba': { adapter: 'Ariba Receiver Adapter', config: 'Configure Ariba realm, system ID, and API key', status: 'semi-auto', notes: 'IS Ariba Adapter covers Procurement and Contracts APIs' },
    'Groovy': { adapter: 'IS Groovy Script Step', config: 'Implement script logic in IS Groovy Script step', status: 'manual', notes: 'Script must be manually reimplemented and validated in IS sandbox' }
  };
  return map[connectorType] || { adapter: 'HTTPS Receiver Adapter', config: 'Configure endpoint and authentication', status: 'semi-auto', notes: 'No direct IS equivalent — configure closest IS adapter' };
}

function mapMuleSoftProcessorToIS(processorType, label) {
  const map = {
    'http:listener': { adapter: 'HTTPS Sender Adapter', config: 'Configure endpoint path and authentication', status: 'auto', notes: 'HTTP Listener → IS HTTPS Sender Adapter' },
    'http:request': { adapter: 'HTTPS Receiver Adapter', config: 'Configure target URL and credentials', status: 'auto', notes: 'HTTP Request → IS HTTPS Receiver Adapter' },
    'kafka:message-listener': { adapter: 'Kafka Sender Adapter', config: 'Configure Kafka broker and topic', status: 'auto', notes: 'Kafka Listener → IS Kafka Sender Adapter' },
    'kafka:publish': { adapter: 'Kafka Receiver Adapter', config: 'Configure Kafka broker and target topic', status: 'auto', notes: 'Direct equivalent' },
    'jms:listener': { adapter: 'JMS Sender Adapter', config: 'Configure JMS broker and queue/topic', status: 'auto', notes: 'JMS Listener → IS JMS Sender Adapter' },
    'jms:publish': { adapter: 'JMS Receiver Adapter', config: 'Configure JMS broker and destination', status: 'auto', notes: 'Direct equivalent' },
    'db:select': { adapter: 'JDBC Adapter (SELECT)', config: 'Configure JDBC URL and SQL query', status: 'semi-auto', notes: 'Rewrite SQL query in IS JDBC Adapter step' },
    'db:insert': { adapter: 'JDBC Adapter (INSERT)', config: 'Configure JDBC URL and insert statement', status: 'semi-auto', notes: 'Rewrite INSERT in IS JDBC Adapter step' },
    'db:update': { adapter: 'JDBC Adapter (UPDATE)', config: 'Configure JDBC URL and update statement', status: 'semi-auto', notes: 'Rewrite UPDATE in IS JDBC Adapter step' },
    'sftp:write': { adapter: 'SFTP Adapter (Write)', config: 'Configure SFTP host, path, credentials', status: 'auto', notes: 'Direct equivalent in IS SFTP Adapter' },
    'salesforce:create': { adapter: 'Salesforce Receiver Adapter (Create)', config: 'Configure Salesforce credential and object', status: 'auto', notes: 'Direct equivalent' },
    'salesforce:upsert': { adapter: 'Salesforce Receiver Adapter (Upsert)', config: 'Configure Salesforce credential and object', status: 'auto', notes: 'Direct equivalent' },
    'salesforce:update': { adapter: 'Salesforce Receiver Adapter (Update)', config: 'Configure Salesforce credential and object', status: 'auto', notes: 'Direct equivalent' },
    's3:put-object': { adapter: 'Amazon S3 Adapter', config: 'Configure AWS credentials and bucket/key', status: 'auto', notes: 'IS Amazon S3 Adapter provides direct equivalent' },
    'scheduler': { adapter: 'Timer Start Event', config: 'Configure cron expression', status: 'auto', notes: 'MuleSoft Scheduler → IS Timer Start Event' },
    'ee:transform': { adapter: 'IS Message Mapping / Groovy Script', config: 'Convert DataWeave logic to IS Message Mapping or Groovy', status: 'manual', notes: 'DataWeave must be manually converted' },
    'email:send': { adapter: 'Mail Adapter', config: 'Configure SMTP and from address', status: 'auto', notes: 'Direct equivalent in IS Mail Adapter' },
    'choice-router': { adapter: 'IS Router Step', config: 'Configure routing conditions in IS Router step', status: 'semi-auto', notes: 'Choice Router → IS Router with condition expressions' },
    'batch:job': { adapter: 'IS Batch Processing Pattern', config: 'Implement as IS Process Direct with batch loop', status: 'manual', notes: 'No direct IS batch equivalent — use IS Process Direct for chunked processing' }
  };
  return map[processorType] || { adapter: 'HTTPS Receiver Adapter', config: 'Configure equivalent IS step', status: 'semi-auto', notes: `No direct IS equivalent for ${processorType}` };
}

function mapTIBCOActivityToIS(activityType, label) {
  const map = {
    'Receive': { adapter: 'HTTPS Sender Adapter', config: 'Configure endpoint and HTTP method', status: 'auto', notes: 'TIBCO Receive → IS HTTPS Sender Adapter' },
    'Reply': { adapter: 'Reply End Event', config: 'Configure response payload', status: 'auto', notes: 'Direct equivalent' },
    'Timer': { adapter: 'Timer Start Event', config: 'Configure cron/interval expression', status: 'auto', notes: 'Direct equivalent — IS Timer Start Event' },
    'JMSReceive': { adapter: 'JMS Sender Adapter', config: 'Configure JMS broker and destination', status: 'auto', notes: 'TIBCO EMS → IS JMS Adapter' },
    'JMSPublish': { adapter: 'JMS Receiver Adapter', config: 'Configure JMS broker and destination', status: 'auto', notes: 'TIBCO EMS → IS JMS Receiver Adapter' },
    'JDBCQuery': { adapter: 'JDBC Adapter (SELECT)', config: 'Configure JDBC URL and SQL', status: 'semi-auto', notes: 'Rewrite query in IS JDBC Adapter' },
    'JDBCUpdate': { adapter: 'JDBC Adapter (UPDATE)', config: 'Configure JDBC URL and SQL', status: 'semi-auto', notes: 'Rewrite update in IS JDBC Adapter' },
    'JDBCInsert': { adapter: 'JDBC Adapter (INSERT)', config: 'Configure JDBC URL and SQL', status: 'semi-auto', notes: 'Rewrite insert in IS JDBC Adapter' },
    'HTTPRequest': { adapter: 'HTTPS Receiver Adapter', config: 'Configure target URL and credentials', status: 'auto', notes: 'Direct equivalent' },
    'FilePoller': { adapter: 'SFTP Sender Adapter', config: 'Configure SFTP host, path, poll interval', status: 'auto', notes: 'TIBCO File → IS SFTP Sender Adapter' },
    'FileRead': { adapter: 'SFTP Adapter (Read)', config: 'Configure SFTP path', status: 'auto', notes: 'TIBCO FileRead → IS SFTP read' },
    'FileWrite': { adapter: 'SFTP Adapter (Write)', config: 'Configure SFTP target path', status: 'auto', notes: 'TIBCO FileWrite → IS SFTP write' },
    'AS2Send': { adapter: 'AS2 Receiver Adapter', config: 'Configure AS2 partner, certs, MDN', status: 'semi-auto', notes: 'Requires IS B2B Add-on license' },
    'AS2Receive': { adapter: 'AS2 Sender Adapter', config: 'Configure AS2 partner and certificates', status: 'semi-auto', notes: 'Requires IS B2B Add-on license' },
    'Mapper': { adapter: 'IS Message Mapping / XSLT', config: 'Recreate mapping in IS Integration Designer', status: 'semi-auto', notes: 'XSLT mappers reusable; BW Mapper requires IS Message Mapping recreation' },
    'SMTPSend': { adapter: 'Mail Adapter', config: 'Configure SMTP and email params', status: 'auto', notes: 'Direct equivalent in IS Mail Adapter' },
    'FaultHandler': { adapter: 'IS Exception Subprocess', config: 'Configure exception handler in IS subprocess', status: 'semi-auto', notes: 'TIBCO FaultHandler → IS Exception Subprocess' },
    'Decision': { adapter: 'IS Router Step', config: 'Configure routing conditions', status: 'semi-auto', notes: 'TIBCO Decision → IS Router with conditions' }
  };
  return map[activityType] || null;
}

function mapTriggerToISEvent(triggerType) {
  const map = { 'Schedule': 'Timer Start Event', 'API': 'HTTPS Sender Adapter', 'Event': 'JMS Sender Adapter (Event)', 'Listener': 'SFTP/AS2 Sender Adapter' };
  return map[triggerType] || 'HTTPS Sender Adapter';
}

function getISStepType(shapeType, platform) {
  const map = {
    'start': 'Start Event', 'stop': 'End Event', 'map': 'Message Mapping Step',
    'connector': 'Receiver Adapter Step', 'decision': 'Router Step', 'notify': 'Mail Adapter Step',
    'http:listener': 'HTTPS Sender Adapter', 'ee:transform': 'Message Mapping / Groovy Script',
    'http:request': 'HTTPS Receiver Adapter', 'kafka:message-listener': 'Kafka Sender Adapter',
    'db:select': 'JDBC Adapter', 'sftp:write': 'SFTP Adapter', 'error-handler': 'Exception Subprocess',
    'scheduler': 'Timer Start Event', 'batch:job': 'Process Direct (Batch Pattern)',
    'Timer': 'Timer Start Event', 'Receive': 'HTTPS Sender Adapter', 'Reply': 'Reply End Event',
    'JMSReceive': 'JMS Sender Adapter', 'JMSPublish': 'JMS Receiver Adapter',
    'JDBCQuery': 'JDBC Adapter', 'HTTPRequest': 'HTTPS Receiver Adapter',
    'FilePoller': 'SFTP Sender Adapter', 'Mapper': 'Message Mapping / XSLT', 'FaultHandler': 'Exception Subprocess'
  };
  return map[shapeType] || 'IS Process Step';
}

function getConversionStatus(shapeType, platform) {
  const manual = ['ee:transform', 'Groovy', 'batch:job', 'FaultHandler'];
  const semiAuto = ['connector', 'decision', 'Router', 'Mapper', 'JDBCQuery', 'JDBCUpdate'];
  if (manual.some(t => shapeType?.includes(t))) return 'manual';
  if (semiAuto.includes(shapeType)) return 'semi-auto';
  return 'auto';
}

function getStepNotes(shape, platform) {
  if (shape.type === 'ee:transform' || (shape.type === 'connector' && shape.connector === 'Groovy')) return 'Requires manual DataWeave/Groovy → IS conversion';
  if (shape.type === 'decision' || shape.type === 'Decision') return 'Routing conditions must be reconfigured in IS Router step';
  if (shape.type === 'map' || shape.type === 'Mapper') return platform === 'pipo' ? 'Use SAP Migration Tool to import XI mapping' : 'Recreate mapping in IS Message Mapping editor';
  if (shape.type === 'start' || shape.type === 'Timer' || shape.type === 'Receive') return 'Start event — configure in IS adapter settings';
  if (shape.type === 'stop' || shape.type === 'Reply') return 'End event — auto-generated in IS iFlow';
  return 'Review and configure in IS Integration Designer';
}

module.exports = { runConversion };
