'use strict';
/**
 * TIBCO BW5 → SAP IS BPMN2 Step Generator (Sprint 8)
 *
 * Converts the `processors` array produced by services/iflow-generator-tibco-bw5.js
 * into real SAP IS BPMN2 XML.
 *
 * BW5 processor types → SAP IS steps:
 *   xslt          → XSLTransformation step (XSLT extracted from mapper activity)
 *   javaScript    → ScriptActivity (Groovy stub, original Java preserved as comment)
 *   invoke/JDBC   → RequestReply + JDBC receiver adapter
 *   invoke/HTTP   → RequestReply + HTTP receiver adapter
 *   invoke/JMS    → RequestReply + JMS receiver adapter
 *   invoke/SFTP   → RequestReply + SFTP receiver adapter
 *   invoke/SMTP   → RequestReply + Mail receiver adapter
 *   invoke/SAP    → RequestReply + IDoc/RFC receiver adapter
 *   processCall   → ProcessCall step
 *   log           → ContentModifier (log header)
 *   contentModifier → ContentModifier
 *
 * Fault handlers (pd:group/catch) → buildBw5ExceptionSubprocesses()
 */

// ── Main: build steps from BW5 processors list ──────────────────────────────
function buildStepsFromBw5Processors(processors, artifact, iflowId) {
  const steps = [];

  for (let i = 0; i < processors.length; i++) {
    const p   = processors[i];
    const k   = (p.type || '').toLowerCase();
    const seq = `bw5_S${i}`;
    const safeName = (p.label || `Step_${i + 1}`).replace(/[<>&"]/g, '').substring(0, 60);

    // XSLT mapping step
    if (k === 'xslt') {
      const xslFile = (p.config && p.config.xslFile) || `${artifact.name.replace(/[^a-zA-Z0-9]/g, '_')}_Map_${i + 1}.xsl`;
      steps.push(buildXsltStep(seq, safeName, xslFile));
      continue;
    }

    // Java → Groovy script stub
    if (k === 'javascript') {
      const scriptFile = (p.config && p.config.scriptFile) || `${artifact.name.replace(/[^a-zA-Z0-9]/g, '_')}_Script_${i + 1}.groovy`;
      steps.push(buildScriptStep(seq, safeName, scriptFile));
      continue;
    }

    // Invoke (outbound call)
    if (k === 'invoke') {
      const connType = (p.config && p.config.connType) || 'HTTP';
      steps.push(buildCallStep(seq, safeName, p.config || {}, connType));
      continue;
    }

    // SubProcess / ProcessCall
    if (k === 'processcall') {
      const target = (p.config && p.config.processName) || 'SubProcess';
      steps.push(buildProcessCallStep(seq, safeName, target));
      continue;
    }

    // Log
    if (k === 'log') {
      steps.push(buildLogStep(seq, safeName));
      continue;
    }

    // ContentModifier (assign, generic, timer/wait note, unknown)
    const note = (p.config && p.config.note) || '';
    steps.push(buildContentModifierStep(seq, safeName, note));
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
        <!-- Extracted from TIBCO BW5 mapper activity inputBindings -->
        <!-- Review XPath field mappings in .xsl file before deploying -->
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:serviceTask>`
  };
}

function buildScriptStep(id, name, scriptFile) {
  const safeName = name.replace(/[^a-zA-Z0-9_\- ]/g, '');
  return {
    id, label: name, _type: 'Script',
    xml: `<bpmn2:serviceTask id="${id}" name="${safeName}" ifl:type="ScriptActivity">
      <bpmn2:extensionElements>
        <ifl:property><key>script</key><value>ref:${scriptFile}</value></ifl:property>
        <ifl:property><key>scriptLanguage</key><value>groovy</value></ifl:property>
        <!-- Migrated from TIBCO BW5 JavaCode activity -->
        <!-- Original Java preserved in .groovy file as comment — implement logic -->
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:serviceTask>`
  };
}

function buildCallStep(id, name, config, connType) {
  const safeConn = (connType || 'HTTP').toLowerCase();

  let extraProps = '';
  if (safeConn === 'jdbc' && config.sql) {
    const safeSql = config.sql.replace(/[<>&"]/g, ' ').substring(0, 300);
    extraProps = `<ifl:property><key>jdbcQuery</key><value>${safeSql}</value></ifl:property>`;
  }
  if (safeConn === 'sap' && config.function) {
    extraProps = `<ifl:property><key>rfcFunctionName</key><value>${config.function.replace(/[<>&"]/g, '')}</value></ifl:property>`;
  }

  return {
    id, label: name, _type: 'RequestReply', _isReceiver: true,
    xml: `<bpmn2:serviceTask id="${id}" name="${name}" ifl:type="RequestReply">
      <bpmn2:extensionElements>
        <ifl:property><key>adapterType</key><value>${safeConn}</value></ifl:property>
        ${extraProps}
        <!-- Migrated from TIBCO BW5 ${connType} activity -->
        <!-- Configure adapter endpoint parameters before deployment -->
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:serviceTask>`
  };
}

function buildProcessCallStep(id, name, processName) {
  const safeProcess = processName.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return {
    id, label: name, _type: 'ProcessCall',
    xml: `<bpmn2:callActivity id="${id}" name="${name}" ifl:type="ProcessCall">
      <bpmn2:extensionElements>
        <ifl:property><key>localWsdlBinding</key><value>${safeProcess}</value></ifl:property>
        <!-- Migrated from TIBCO BW5 SubProcess call to "${processName}" -->
        <!-- Create a corresponding Process Direct iFlow named "${safeProcess}" -->
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:callActivity>`
  };
}

function buildLogStep(id, name) {
  return {
    id, label: name, _type: 'ContentModifier',
    xml: `<bpmn2:serviceTask id="${id}" name="${name}" ifl:type="ContentModifier">
      <bpmn2:extensionElements>
        <ifl:property><key>action</key><value>Create</value></ifl:property>
        <ifl:property><key>dataStoreLocation</key><value>Message Header</value></ifl:property>
        <ifl:property><key>name</key><value>X-BW5-Log</value></ifl:property>
        <ifl:property><key>type</key><value>expression</value></ifl:property>
        <ifl:property><key>value</key><value>${name.replace(/[<>&"]/g, '').substring(0, 80)}</value></ifl:property>
        <!-- Migrated from TIBCO BW5 Log activity -->
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:serviceTask>`
  };
}

function buildContentModifierStep(id, name, note) {
  const safeNote = (note || name).replace(/[<>&"]/g, ' ').substring(0, 100);
  return {
    id, label: name, _type: 'ContentModifier',
    xml: `<bpmn2:serviceTask id="${id}" name="${name}" ifl:type="ContentModifier">
      <bpmn2:extensionElements>
        <ifl:property><key>action</key><value>Create</value></ifl:property>
        <ifl:property><key>dataStoreLocation</key><value>Exchange Property</value></ifl:property>
        <ifl:property><key>name</key><value>bw5_${id}</value></ifl:property>
        <ifl:property><key>type</key><value>expression</value></ifl:property>
        <ifl:property><key>value</key><value>{{placeholder}}</value></ifl:property>
        <!-- ${safeNote} -->
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:serviceTask>`
  };
}

// ── Exception sub-processes from BW5 group/catch ─────────────────────────────
function buildBw5ExceptionSubprocesses(errorHandlers, iflowId) {
  if (!errorHandlers || errorHandlers.length === 0) return '';

  return errorHandlers.map((eh, i) => {
    const subId     = `Bw5ExcSub_${i + 1}_${iflowId}`;
    const faultName = (eh.faultName || 'CatchGroup').replace(/[<>&"]/g, '');
    return `
    <!-- ── BW5 Exception Sub-process ${i + 1} (migrated from pd:group: ${faultName}) ── -->
    <bpmn2:subProcess id="${subId}" name="Handle ${faultName}" triggeredByEvent="true" isForCompensation="false">
      <bpmn2:extensionElements>
        <ifl:property><key>activityType</key><value>ExceptionSubprocess</value></ifl:property>
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
          <ifl:property><key>value</key><value>bw5-catch-${faultName}</value></ifl:property>
          <!-- TODO: Add error logging and appropriate response body -->
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
    flows.push(`<bpmn2:sequenceFlow id="SEQ_FROM_${curr.id}" sourceRef="${curr.id}" targetRef="${next.id}" name=""/>`);
  }

  const last = steps[steps.length - 1];
  flows.push(`<bpmn2:sequenceFlow id="SEQ_FROM_${last.id}" sourceRef="${last.id}" targetRef="EndEvent_${iflowId}" name=""/>`);

  return flows.join('\n    ');
}

// ── Full BPMN2 XML builder for TIBCO BW5 artifacts ───────────────────────────
function buildBw5BPMN(artifact, platformData, iflowId, iflowName, senderAdapterName, receiverAdapterName) {
  const domain       = artifact.domain || 'INT';
  const processors   = platformData.processors || [];
  const errorHandlers = platformData.errorHandlers || [];
  const senderCfg    = platformData.senderConfig  || {};
  const receiverCfg  = (platformData.receiverConfigs && platformData.receiverConfigs[0]) || {};

  const steps = buildStepsFromBw5Processors(processors, artifact, iflowId);

  // Add context header at start
  steps.unshift({
    id: 'bw5_ctx', label: 'Set Context', _type: 'ContentModifier',
    xml: `<bpmn2:serviceTask id="bw5_ctx" name="Set Migration Context" ifl:type="ContentModifier">
      <bpmn2:extensionElements>
        <ifl:property><key>action</key><value>Create</value></ifl:property>
        <ifl:property><key>dataStoreLocation</key><value>Message Header</value></ifl:property>
        <ifl:property><key>name</key><value>X-Source-Platform</value></ifl:property>
        <ifl:property><key>type</key><value>expression</value></ifl:property>
        <ifl:property><key>value</key><value>TIBCO_BW5</value></ifl:property>
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_bw5_ctx</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_bw5_ctx</bpmn2:outgoing>
    </bpmn2:serviceTask>`
  });

  const stepsXml   = steps.map(s => '    ' + s.xml).join('\n\n');
  const seqFlows   = buildSequenceFlowsFromSteps(steps, iflowId);
  const excSubs    = buildBw5ExceptionSubprocesses(errorHandlers, iflowId);
  const stepSummary = steps.map((s, i) => `     Step ${i + 1}: [${s._type}] ${s.label}`).join('\n');

  const senderExts   = buildBw5SenderExtensions(senderCfg, artifact);
  const receiverExts = buildBw5ReceiverExtensions(receiverCfg, artifact);

  const xsltCount = (platformData.xsltTransforms || []).length;
  const javaCount = (platformData.javaScripts    || []).length;

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
    Source: TIBCO BW5 — ${artifact.name}
    Domain: ${domain} | Trigger: ${artifact.trigger_type || 'API'} | Complexity: ${artifact.complexity_level || 'Medium'}
    Connectors: ${(platformData.connectorTypes || []).join(', ') || 'HTTP'}
    XSLT Mappings: ${xsltCount} extracted | Java→Groovy stubs: ${javaCount}
    Fault Handlers: ${errorHandlers.length}
    Completeness: ${platformData.completenessScore || 80}%
    Generated: ${new Date().toISOString()}
    Sierra Digital — IS Migration Tool (S8)

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
function buildBw5SenderExtensions(sender, artifact) {
  const type = sender.type || 'HTTP';

  if (type === 'Schedule' || type === 'Timer') {
    const cron = sender.cronExpr || '0 0/1 * * * ?';
    return `<ifl:property><key>adapterType</key><value>scheduler</value></ifl:property>
        <ifl:property><key>cronExpression</key><value>${cron}</value></ifl:property>
        <ifl:property><key>schedulerType</key><value>fixedRate</value></ifl:property>
        <!-- Migrated from BW5 Timer starter — update schedule in IS -->`;
  }
  if (type === 'JMS') {
    return `<ifl:property><key>adapterType</key><value>jms</value></ifl:property>
        <ifl:property><key>queueName</key><value>${(sender.queue || '{{param.jms.queue.name}}').replace(/[<>&"]/g, '')}</value></ifl:property>
        <ifl:property><key>connectionFactory</key><value>{{param.jms.connection.factory}}</value></ifl:property>
        <!-- Migrated from BW5 JMS/EMS starter -->`;
  }
  if (type === 'SFTP') {
    return `<ifl:property><key>adapterType</key><value>sftp</value></ifl:property>
        <ifl:property><key>directoryName</key><value>${(sender.directory || '/inbound').replace(/[<>&"]/g, '')}</value></ifl:property>
        <ifl:property><key>hostName</key><value>{{param.sftp.host}}</value></ifl:property>
        <ifl:property><key>port</key><value>22</value></ifl:property>
        <!-- Migrated from BW5 File/SFTP starter -->`;
  }
  if (type === 'SOAP') {
    return `<ifl:property><key>adapterType</key><value>soap</value></ifl:property>
        <ifl:property><key>address</key><value>{{param.sender.soap.address}}</value></ifl:property>
        <ifl:property><key>wsdlUrl</key><value>${(sender.wsdl || '{{param.wsdl.url}}').replace(/[<>&"]/g, '')}</value></ifl:property>
        <!-- Migrated from BW5 SOAP/WSDL starter -->`;
  }
  // Default HTTP
  const path   = (sender.path   || `/${artifact.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`).replace(/[<>&"]/g, '');
  const method = (sender.method || 'POST').replace(/[<>&"]/g, '');
  return `<ifl:property><key>adapterType</key><value>http</value></ifl:property>
        <ifl:property><key>address</key><value>{{param.sender.address}}</value></ifl:property>
        <ifl:property><key>httpPath</key><value>${path}</value></ifl:property>
        <ifl:property><key>allowedMethods</key><value>${method}</value></ifl:property>
        <ifl:property><key>userRole</key><value>ESBMessaging.send</value></ifl:property>
        <!-- Migrated from BW5 HTTP starter -->`;
}

function buildBw5ReceiverExtensions(rc, artifact) {
  if (!rc || !rc.type) {
    return `<ifl:property><key>adapterType</key><value>http</value></ifl:property>
        <ifl:property><key>address</key><value>{{param.receiver.http.address}}</value></ifl:property>`;
  }
  switch (rc.type) {
    case 'JDBC':
      return `<ifl:property><key>adapterType</key><value>jdbc</value></ifl:property>
        <ifl:property><key>dataSourceAlias</key><value>{{param.receiver.jdbc.datasource}}</value></ifl:property>
        ${rc.sql ? `<ifl:property><key>query</key><value>${rc.sql.replace(/[<>&"]/g, ' ').substring(0, 300)}</value></ifl:property>` : ''}
        <ifl:property><key>operation</key><value>SELECT</value></ifl:property>`;
    case 'JMS':
      return `<ifl:property><key>adapterType</key><value>jms</value></ifl:property>
        <ifl:property><key>queueName</key><value>{{param.jms.queue.name}}</value></ifl:property>
        <ifl:property><key>connectionFactory</key><value>{{param.jms.connection.factory}}</value></ifl:property>`;
    case 'SFTP':
      return `<ifl:property><key>adapterType</key><value>sftp</value></ifl:property>
        <ifl:property><key>hostName</key><value>{{param.receiver.sftp.host}}</value></ifl:property>
        <ifl:property><key>directoryName</key><value>/outbound</value></ifl:property>`;
    case 'SMTP':
      return `<ifl:property><key>adapterType</key><value>mail</value></ifl:property>
        <ifl:property><key>mailHostName</key><value>{{param.smtp.host}}</value></ifl:property>
        <ifl:property><key>from</key><value>{{param.smtp.from}}</value></ifl:property>
        <ifl:property><key>to</key><value>{{param.smtp.to}}</value></ifl:property>`;
    case 'SAP':
      return `<ifl:property><key>adapterType</key><value>idoc</value></ifl:property>
        <ifl:property><key>rfcFunctionName</key><value>${(rc.function || '{{param.sap.function}}').replace(/[<>&"]/g, '')}</value></ifl:property>
        <ifl:property><key>sapClient</key><value>{{param.sap.client}}</value></ifl:property>
        <ifl:property><key>sapHost</key><value>{{param.sap.host}}</value></ifl:property>`;
    case 'SOAP':
      return `<ifl:property><key>adapterType</key><value>soap</value></ifl:property>
        <ifl:property><key>address</key><value>{{param.receiver.soap.address}}</value></ifl:property>`;
    default:
      return `<ifl:property><key>adapterType</key><value>http</value></ifl:property>
        <ifl:property><key>address</key><value>${(rc.url || '{{param.receiver.http.address}}').replace(/[<>&"]/g, '')}</value></ifl:property>`;
  }
}

module.exports = { buildBw5BPMN };
