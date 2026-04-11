'use strict';
/**
 * TIBCO BW6 → SAP IS BPMN2 Step Generator (Sprint 7)
 *
 * Converts the `processors` array produced by services/iflow-generator-tibco-bw6.js
 * into real SAP IS BPMN2 XML.
 *
 * Supported step types (from BW6 processor extraction):
 *   xslt            → XSLTransformation step (XSLT 1.0 native — real content from HTML-unescaped expression)
 *   invoke          → RequestReply step (HTTP/JDBC/JMS/SFTP/SAP receiver)
 *   contentModifier → ContentModifier step (assign, set variable)
 *   router          → Router step (if/switch)
 *   splitter        → IteratingSplitter (forEach/while)
 *   scope           → Sub-process note
 *   reply           → folded into end event (no step emitted)
 *   throw           → Error end event note
 *
 * Fault handlers → buildBw6ExceptionSubprocesses()
 */

// ── Main: build steps from BW6 processors list ──────────────────────────────
function buildStepsFromBw6Processors(processors, artifact, iflowId) {
  const steps = [];

  for (let i = 0; i < processors.length; i++) {
    const p   = processors[i];
    const k   = (p.type || '').toLowerCase();
    const seq = `bw6_S${i}`;

    // XSLT mapping — emit a real XSLTransformation step referencing the .xsl file
    if (k === 'xslt') {
      const xslFile  = (p.config && p.config.xslFile) || `${artifact.name.replace(/[^a-zA-Z0-9]/g, '_')}_Transform_${i + 1}.xsl`;
      const safeName = (p.label || `XSLT_Transform_${i + 1}`).replace(/[<>&"]/g, '').substring(0, 60);
      steps.push(buildXsltStep(seq, safeName, xslFile));
      continue;
    }

    // Invoke → RequestReply call (receiver adapter handles external call)
    if (k === 'invoke') {
      const connType = (p.config && p.config.connType) || 'HTTP';
      const safeName = (p.label || `Call_${connType}_${i + 1}`).replace(/[<>&"]/g, '').substring(0, 60);
      steps.push(buildCallStep(seq, safeName, p.config || {}, connType));
      continue;
    }

    // Reply → end event handles this; skip as a separate step
    if (k === 'reply') continue;

    // Router (if/switch)
    if (k === 'router') {
      const safeName = (p.label || 'BW6 Router').replace(/[<>&"]/g, '').substring(0, 60);
      steps.push(buildRouterStep(seq, safeName, iflowId));
      continue;
    }

    // Splitter (forEach/while)
    if (k === 'splitter') {
      const safeName = (p.label || 'Iterating Splitter').replace(/[<>&"]/g, '').substring(0, 60);
      steps.push(buildSplitterStep(seq, safeName));
      steps.push(buildAggregatorStep(`${seq}a`, 'Gather'));
      continue;
    }

    // Scope → note step
    if (k === 'scope') {
      const safeName = (p.label || 'Scope').replace(/[<>&"]/g, '').substring(0, 60);
      steps.push(buildNoteStep(seq, safeName, 'Migrated from TIBCO BW6 scope — review sub-process boundary in IS Integration Designer'));
      continue;
    }

    // Throw → error note
    if (k === 'throw') {
      steps.push(buildNoteStep(seq, p.label || 'Throw Error', 'TIBCO BW6 throw — map to IS error end event or custom error response'));
      continue;
    }

    // Content Modifier (assign / set variable / generic activity)
    const safeName = (p.label || `Set_${i + 1}`).replace(/[<>&"]/g, '').substring(0, 60);
    steps.push(buildContentModifierStep(seq, safeName, `bw6_${seq}`));
  }

  return steps;
}

// ── Step Builders ─────────────────────────────────────────────────────────────

function buildXsltStep(id, name, xslFile) {
  return {
    id, label: name, _type: 'XSLT',
    xml: `<bpmn2:serviceTask id="${id}" name="${name}" ifl:type="XSLTransformation">
      <bpmn2:extensionElements>
        <ifl:property><key>xslName</key><value>${xslFile}</value></ifl:property>
        <ifl:property><key>xslFileSource</key><value>classpath</value></ifl:property>
        <ifl:property><key>outputXMLEncoding</key><value>UTF-8</value></ifl:property>
        <!-- XSLT 1.0 extracted from TIBCO BW6 tibex:inputBinding expression (HTML-unescaped) -->
        <!-- SAP IS supports XSLT 1.0 natively — no translation needed -->
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:serviceTask>`
  };
}

function buildCallStep(id, name, config, connType) {
  const safeConn = (connType || 'HTTP').toLowerCase();
  const jdbcProp = safeConn === 'jdbc'
    ? `<ifl:property><key>jdbcQuery</key><value>{{param.jdbc.query}}</value></ifl:property>`
    : '';
  const sapProp = safeConn === 'sap'
    ? `<ifl:property><key>functionName</key><value>${(config.function || '{{param.sap.function}}').replace(/[<>&"]/g, '')}</value></ifl:property>`
    : '';
  return {
    id, label: name, _type: 'RequestReply', _isReceiver: true,
    xml: `<bpmn2:serviceTask id="${id}" name="${name}" ifl:type="RequestReply">
      <bpmn2:extensionElements>
        <ifl:property><key>adapterType</key><value>${safeConn}</value></ifl:property>
        ${jdbcProp}${sapProp}
        <!-- Migrated from TIBCO BW6 bpws:invoke — partnerLink: ${(config.partnerLink || '').replace(/[<>&"]/g, '')} -->
        <!-- Configure adapter endpoint in IS Integration Designer -->
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:serviceTask>`
  };
}

function buildContentModifierStep(id, name, label) {
  return {
    id, label: name, _type: 'ContentModifier',
    xml: `<bpmn2:serviceTask id="${id}" name="${name}" ifl:type="ContentModifier">
      <bpmn2:extensionElements>
        <ifl:property><key>action</key><value>Create</value></ifl:property>
        <ifl:property><key>dataStoreLocation</key><value>Exchange Property</value></ifl:property>
        <ifl:property><key>name</key><value>bw6_${label}</value></ifl:property>
        <ifl:property><key>type</key><value>expression</value></ifl:property>
        <ifl:property><key>value</key><value>{{placeholder}}</value></ifl:property>
        <!-- Migrated from TIBCO BW6 bpws:assign — update value expression -->
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:serviceTask>`
  };
}

function buildRouterStep(id, name, iflowId) {
  return {
    id, label: name, _type: 'Router',
    routeCount: 2,
    xml: `<bpmn2:exclusiveGateway id="${id}" name="${name}" ifl:type="Router">
      <bpmn2:extensionElements>
        <ifl:property><key>numberOfRoutes</key><value>2</value></ifl:property>
        <ifl:property><key>route1Condition</key><value>{{condition_1}}</value></ifl:property>
        <ifl:property><key>route1Name</key><value>Route_1</value></ifl:property>
        <ifl:property><key>defaultRoute</key><value>Default</value></ifl:property>
        <!-- Migrated from TIBCO BW6 bpws:if/switch — extract conditions from source -->
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}_R1</bpmn2:outgoing>
      <bpmn2:outgoing>SEQ_FROM_${id}_DEFAULT</bpmn2:outgoing>
    </bpmn2:exclusiveGateway>`
  };
}

function buildSplitterStep(id, name) {
  return {
    id, label: name, _type: 'Splitter',
    xml: `<bpmn2:serviceTask id="${id}" name="${name}" ifl:type="IteratingSplitter">
      <bpmn2:extensionElements>
        <ifl:property><key>expressionType</key><value>XPath</value></ifl:property>
        <ifl:property><key>expression</key><value>/root/items/item</value></ifl:property>
        <ifl:property><key>stopOnException</key><value>false</value></ifl:property>
        <!-- Migrated from TIBCO BW6 forEach/while — update XPath to match message structure -->
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:serviceTask>`
  };
}

function buildAggregatorStep(id, name) {
  return {
    id, label: name, _type: 'Aggregator',
    xml: `<bpmn2:serviceTask id="${id}" name="${name}" ifl:type="IteratingAggregator">
      <bpmn2:extensionElements>
        <ifl:property><key>aggregationAlgorithm</key><value>CombineInSequence</value></ifl:property>
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:serviceTask>`
  };
}

function buildNoteStep(id, name, note) {
  return {
    id, label: name, _type: 'ContentModifier',
    xml: `<bpmn2:serviceTask id="${id}" name="${name}" ifl:type="ContentModifier">
      <bpmn2:extensionElements>
        <ifl:property><key>action</key><value>Create</value></ifl:property>
        <ifl:property><key>dataStoreLocation</key><value>Message Header</value></ifl:property>
        <ifl:property><key>name</key><value>X-Migration-Note</value></ifl:property>
        <ifl:property><key>type</key><value>expression</value></ifl:property>
        <ifl:property><key>value</key><value>${note.replace(/[<>&"]/g, ' ').substring(0, 100)}</value></ifl:property>
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:serviceTask>`
  };
}

// ── Exception sub-processes from BW6 faultHandlers ─────────────────────────
function buildBw6ExceptionSubprocesses(errorHandlers, iflowId) {
  if (!errorHandlers || errorHandlers.length === 0) return '';

  return errorHandlers.map((eh, i) => {
    const subId     = `Bw6ExcSub_${i + 1}_${iflowId}`;
    const faultName = (eh.faultName || 'GenericFault').replace(/[<>&"]/g, '');
    const isCatchAll = eh.type === 'catchAll';
    return `
    <!-- ── BW6 Exception Sub-process ${i + 1} (migrated from bpws:${isCatchAll ? 'catchAll' : 'catch'}: ${faultName}) ── -->
    <bpmn2:subProcess id="${subId}" name="Handle ${faultName}" triggeredByEvent="true" isForCompensation="false">
      <bpmn2:extensionElements>
        <ifl:property><key>activityType</key><value>ExceptionSubprocess</value></ifl:property>
        ${!isCatchAll ? `<ifl:property><key>errorMatchCondition</key><value>${faultName}</value></ifl:property>` : ''}
      </bpmn2:extensionElements>

      <bpmn2:startEvent id="${subId}_Start" name="Error Start" isInterrupting="true">
        <bpmn2:errorEventDefinition/>
        <bpmn2:outgoing>SEQ_${subId}_Start_CM</bpmn2:outgoing>
      </bpmn2:startEvent>

      <bpmn2:serviceTask id="${subId}_CM" name="Set Error Response" ifl:type="ContentModifier">
        <bpmn2:extensionElements>
          <ifl:property><key>action</key><value>Create</value></ifl:property>
          <ifl:property><key>dataStoreLocation</key><value>Message Header</value></ifl:property>
          <ifl:property><key>name</key><value>X-Error-Handler</value></ifl:property>
          <ifl:property><key>type</key><value>expression</value></ifl:property>
          <ifl:property><key>value</key><value>bw6-fault-${faultName}</value></ifl:property>
          <!-- TODO: Add appropriate error logging and response body here -->
        </bpmn2:extensionElements>
        <bpmn2:incoming>SEQ_${subId}_Start_CM</bpmn2:incoming>
        <bpmn2:outgoing>SEQ_${subId}_CM_End</bpmn2:outgoing>
      </bpmn2:serviceTask>

      <bpmn2:endEvent id="${subId}_End" name="Error End">
        <bpmn2:errorEventDefinition/>
        <bpmn2:incoming>SEQ_${subId}_CM_End</bpmn2:incoming>
      </bpmn2:endEvent>

      <bpmn2:sequenceFlow id="SEQ_${subId}_Start_CM" sourceRef="${subId}_Start" targetRef="${subId}_CM"/>
      <bpmn2:sequenceFlow id="SEQ_${subId}_CM_End"   sourceRef="${subId}_CM"   targetRef="${subId}_End"/>
    </bpmn2:subProcess>`;
  }).join('\n');
}

// ── Sequence flows ────────────────────────────────────────────────────────────
function buildSequenceFlowsFromSteps(steps, iflowId) {
  if (!steps.length) {
    return `<bpmn2:sequenceFlow id="SEQ_Start_End" sourceRef="StartEvent_${iflowId}" targetRef="EndEvent_${iflowId}" name=""/>`;
  }

  const flows = [];
  flows.push(`<bpmn2:sequenceFlow id="SEQ_Start_To_${steps[0].id}" sourceRef="StartEvent_${iflowId}" targetRef="${steps[0].id}" name=""/>`);

  for (let i = 0; i < steps.length - 1; i++) {
    const curr = steps[i];
    const next = steps[i + 1];
    const srcFlow = curr._type === 'Router' ? `SEQ_FROM_${curr.id}_DEFAULT` : `SEQ_FROM_${curr.id}`;
    flows.push(`<bpmn2:sequenceFlow id="${srcFlow}" sourceRef="${curr.id}" targetRef="${next.id}" name=""/>`);
  }

  const last = steps[steps.length - 1];
  flows.push(`<bpmn2:sequenceFlow id="SEQ_FROM_${last.id}" sourceRef="${last.id}" targetRef="EndEvent_${iflowId}" name=""/>`);

  return flows.join('\n    ');
}

// ── Full BPMN2 XML builder for TIBCO BW6 artifacts ───────────────────────────
function buildBw6BPMN(artifact, platformData, iflowId, iflowName, senderAdapterName, receiverAdapterName) {
  const domain       = artifact.domain || 'INT';
  const processors   = platformData.processors || [];
  const errorHandlers = platformData.errorHandlers || [];
  const senderCfg    = platformData.senderConfig  || {};
  const receiverCfg  = (platformData.receiverConfigs && platformData.receiverConfigs[0]) || {};

  const steps = buildStepsFromBw6Processors(processors, artifact, iflowId);

  // Inject context header at start if no content modifiers
  if (!steps.some(s => s._type === 'ContentModifier')) {
    steps.unshift({
      id: 'bw6_ctx', label: 'Set Context', _type: 'ContentModifier',
      xml: `<bpmn2:serviceTask id="bw6_ctx" name="Set Migration Context" ifl:type="ContentModifier">
      <bpmn2:extensionElements>
        <ifl:property><key>action</key><value>Create</value></ifl:property>
        <ifl:property><key>dataStoreLocation</key><value>Message Header</value></ifl:property>
        <ifl:property><key>name</key><value>X-Source-Platform</value></ifl:property>
        <ifl:property><key>type</key><value>expression</value></ifl:property>
        <ifl:property><key>value</key><value>TIBCO_BW6</value></ifl:property>
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_bw6_ctx</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_bw6_ctx</bpmn2:outgoing>
    </bpmn2:serviceTask>`
    });
  }

  const stepsXml  = steps.map(s => '    ' + s.xml).join('\n\n');
  const seqFlows  = buildSequenceFlowsFromSteps(steps, iflowId);
  const excSubs   = buildBw6ExceptionSubprocesses(errorHandlers, iflowId);
  const stepSummary = steps.map((s, i) => `     Step ${i + 1}: [${s._type}] ${s.label}`).join('\n');

  const senderExts   = buildBw6SenderExtensions(senderCfg, artifact);
  const receiverExts = buildBw6ReceiverExtensions(receiverCfg, artifact);

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
    xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
    xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
    xmlns:ifl="http:///com.sap.ifl.model/Ifl.xsd"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="${iflowId}"
    targetNamespace="http://www.sap.com/${iflowId}">

  <!--
    ════════════════════════════════════════════════════════════════════
    iFlow: ${iflowName}
    Source: TIBCO BW6 — ${artifact.name}
    Domain: ${domain} | Trigger: ${artifact.trigger_type || 'API'} | Complexity: ${artifact.complexity_level || 'Medium'}
    Connectors: ${(platformData.connectorTypes || []).join(', ') || 'HTTP'}
    XSLT Mappings: ${(platformData.xsltTransforms || []).length} (extracted, XSLT 1.0 — SAP IS native)
    Fault Handlers: ${errorHandlers.length}
    Completeness: ${platformData.completenessScore || 80}%
    Generated: ${new Date().toISOString()}
    Sierra Digital — IS Migration Tool (S7)

    Generated Steps:
${stepSummary}
    ════════════════════════════════════════════════════════════════════
  -->

  <bpmn2:collaboration id="Collaboration_${iflowId}" name="${iflowName}">

    <bpmn2:participant id="Sender" name="Sender" ifl:type="ExternalSender">
      <bpmn2:extensionElements>
        <ifl:property><key>enableBasicAuthCredentials</key><value>true</value></ifl:property>
      </bpmn2:extensionElements>
    </bpmn2:participant>

    <bpmn2:participant id="Process_${iflowId}" name="${iflowName}"
        processRef="IntegrationProcess_${iflowId}">
    </bpmn2:participant>

    <bpmn2:participant id="Receiver" name="Receiver" ifl:type="ExternalReceiver">
      <bpmn2:extensionElements>
        <ifl:property><key>adapterType</key><value>${(receiverCfg.type || 'http').toLowerCase()}</value></ifl:property>
      </bpmn2:extensionElements>
    </bpmn2:participant>

    <bpmn2:messageFlow id="MF_Sender_To_Process"
        sourceRef="Sender" targetRef="StartEvent_${iflowId}"
        name="${senderAdapterName}" ifl:type="senderChannel">
      <bpmn2:extensionElements>
        ${senderExts}
      </bpmn2:extensionElements>
    </bpmn2:messageFlow>

    <bpmn2:messageFlow id="MF_Process_To_Receiver"
        sourceRef="EndEvent_${iflowId}" targetRef="Receiver"
        name="${receiverAdapterName}" ifl:type="receiverChannel">
      <bpmn2:extensionElements>
        ${receiverExts}
      </bpmn2:extensionElements>
    </bpmn2:messageFlow>

  </bpmn2:collaboration>

  <bpmn2:process id="IntegrationProcess_${iflowId}" name="${iflowName}" isExecutable="true">

    <bpmn2:startEvent id="StartEvent_${iflowId}" name="Start">
      <bpmn2:outgoing>SEQ_Start_To_${steps[0] ? steps[0].id : 'EndEvent_' + iflowId}</bpmn2:outgoing>
    </bpmn2:startEvent>

${stepsXml}

    <bpmn2:endEvent id="EndEvent_${iflowId}" name="End">
      <bpmn2:incoming>SEQ_FROM_${steps.length ? steps[steps.length - 1].id : 'StartEvent_' + iflowId}</bpmn2:incoming>
    </bpmn2:endEvent>

    ${seqFlows}

    ${excSubs}

  </bpmn2:process>

  <bpmndi:BPMNDiagram id="BPMNDiagram_${iflowId}">
    <bpmndi:BPMNPlane id="BPMNPlane_${iflowId}" bpmnElement="Collaboration_${iflowId}">
      <!-- Open in SAP Integration Suite Designer to arrange diagram layout -->
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>

</bpmn2:definitions>`;
}

// ── Channel extension builders ────────────────────────────────────────────────
function buildBw6SenderExtensions(sender, artifact) {
  const type = sender.type || 'HTTP';
  if (type === 'Schedule' || type === 'Timer') {
    const freq = sender.frequency || '0 0 * * *';
    return `<ifl:property><key>adapterType</key><value>scheduler</value></ifl:property>
        <ifl:property><key>cronExpression</key><value>${freq}</value></ifl:property>
        <ifl:property><key>schedulerType</key><value>fixedRate</value></ifl:property>`;
  }
  if (type === 'JMS') {
    return `<ifl:property><key>adapterType</key><value>jms</value></ifl:property>
        <ifl:property><key>queueName</key><value>${(sender.queue || '{{param.jms.queue.name}}').replace(/[<>&"]/g, '')}</value></ifl:property>
        <ifl:property><key>connectionFactory</key><value>{{param.jms.connection.factory}}</value></ifl:property>`;
  }
  if (type === 'SFTP') {
    return `<ifl:property><key>adapterType</key><value>sftp</value></ifl:property>
        <ifl:property><key>directoryName</key><value>${(sender.directory || '/inbound').replace(/[<>&"]/g, '')}</value></ifl:property>
        <ifl:property><key>hostName</key><value>{{param.sftp.host}}</value></ifl:property>
        <ifl:property><key>port</key><value>22</value></ifl:property>`;
  }
  // Default: HTTP
  const path = (sender.path || `/http/${artifact.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`).replace(/[<>&"]/g, '');
  return `<ifl:property><key>adapterType</key><value>http</value></ifl:property>
        <ifl:property><key>address</key><value>{{param.sender.address}}</value></ifl:property>
        <ifl:property><key>httpPath</key><value>${path}</value></ifl:property>
        <ifl:property><key>allowedMethods</key><value>${sender.method || 'POST'}</value></ifl:property>
        <ifl:property><key>userRole</key><value>ESBMessaging.send</value></ifl:property>`;
}

function buildBw6ReceiverExtensions(rc, artifact) {
  if (!rc || !rc.type) {
    return `<ifl:property><key>adapterType</key><value>http</value></ifl:property>
        <ifl:property><key>address</key><value>{{param.receiver.http.address}}</value></ifl:property>`;
  }
  switch (rc.type) {
    case 'JDBC':
      return `<ifl:property><key>adapterType</key><value>jdbc</value></ifl:property>
        <ifl:property><key>dataSourceAlias</key><value>{{param.receiver.jdbc.datasource}}</value></ifl:property>
        <ifl:property><key>operation</key><value>SELECT</value></ifl:property>`;
    case 'JMS':
      return `<ifl:property><key>adapterType</key><value>jms</value></ifl:property>
        <ifl:property><key>queueName</key><value>${(rc.queue || '{{param.jms.queue.name}}').replace(/[<>&"]/g, '')}</value></ifl:property>
        <ifl:property><key>connectionFactory</key><value>{{param.jms.connection.factory}}</value></ifl:property>`;
    case 'SFTP':
      return `<ifl:property><key>adapterType</key><value>sftp</value></ifl:property>
        <ifl:property><key>hostName</key><value>{{param.receiver.sftp.host}}</value></ifl:property>
        <ifl:property><key>directoryName</key><value>${(rc.directory || '/outbound').replace(/[<>&"]/g, '')}</value></ifl:property>`;
    case 'SAP':
      return `<ifl:property><key>adapterType</key><value>idoc</value></ifl:property>
        <ifl:property><key>rfcFunctionName</key><value>${(rc.function || '{{param.sap.function}}').replace(/[<>&"]/g, '')}</value></ifl:property>
        <ifl:property><key>sapClient</key><value>{{param.sap.client}}</value></ifl:property>
        <ifl:property><key>sapHost</key><value>{{param.sap.host}}</value></ifl:property>`;
    case 'SMTP':
      return `<ifl:property><key>adapterType</key><value>mail</value></ifl:property>
        <ifl:property><key>mailHostName</key><value>{{param.smtp.host}}</value></ifl:property>
        <ifl:property><key>from</key><value>{{param.smtp.from}}</value></ifl:property>
        <ifl:property><key>to</key><value>{{param.smtp.to}}</value></ifl:property>`;
    default:
      return `<ifl:property><key>adapterType</key><value>http</value></ifl:property>
        <ifl:property><key>address</key><value>${(rc.url || '{{param.receiver.http.address}}').replace(/[<>&"]/g, '')}</value></ifl:property>`;
  }
}

module.exports = { buildBw6BPMN };
