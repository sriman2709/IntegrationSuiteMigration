'use strict';
/**
 * MuleSoft → SAP IS BPMN2 Step Generator (Sprint 4)
 *
 * Converts the `processors` array produced by services/iflow-generator-mulesoft.js
 * (Sprint 3) into real SAP IS BPMN2 XML step sequence.
 *
 * Supported step types:
 *   http:listener / jms:listener / sftp / scheduler  → sender channel (handled in outer collab)
 *   set-payload / set-variable / logger               → Content Modifier
 *   transform-message (DataWeave)                     → Script Activity (Groovy stub) or XSLT
 *   choice                                            → Router step with extracted conditions
 *   scatter-gather                                    → Parallel Multicast
 *   foreach                                           → Iterating Splitter + Aggregator
 *   enricher                                          → Content Enricher
 *   flow-ref                                          → Process Call
 *   http:request / db / sftp / jms / sfdc / sap       → handled as part of receiver channel,
 *                                                        + intermediate Call step if multiple receivers
 *   catch-exception-strategy                          → Exception Sub-process
 *   logger                                            → Content Modifier (log note)
 */

// ── Main: build process steps from processors list ───────────────────────────
function buildStepsFromProcessors(processors, artifact, iflowId, platformData) {
  const steps    = [];
  const scripts  = platformData.scripts || [];
  let   scriptIdx = 0;
  let   mapIdx    = 0;

  for (let i = 0; i < processors.length; i++) {
    const p   = processors[i];
    const k   = (p.type || '').toLowerCase();
    const seq = `S${i}`;

    // Skip sender triggers — handled by sender channel in collaboration
    if (isSenderElement(k)) continue;

    // Skip outbound connectors beyond first — they're receiver channels
    // (multiple receivers become separate iFlow processes in a real migration)
    if (isReceiverConnector(k) && steps.some(s => s._isReceiver)) continue;

    if (isReceiverConnector(k)) {
      // Mark a proxy step for the receiver call
      steps.push(buildCallStep(seq, p.label || 'Call Receiver', p.config || {}, true));
      continue;
    }

    // ── DataWeave transform → Script + XSLT ─────────────────────────────────
    if (k.includes('transform') || k === 'transform-message' || k === 'ee:transform') {
      const script = scripts[scriptIdx++];
      const name   = script ? script.name.replace(/[^a-zA-Z0-9_]/g, '_') : `Transform_${mapIdx + 1}`;
      steps.push(buildScriptStep(seq, name, `Script_${seq}`, script));
      mapIdx++;
      continue;
    }

    // ── Choice router ────────────────────────────────────────────────────────
    if (k === 'choice') {
      const conditions = (p.config && p.config.conditions) || [];
      steps.push(buildRouterStep(seq, p.label || 'Router', conditions, iflowId));
      continue;
    }

    // ── Scatter-gather → Parallel Multicast ─────────────────────────────────
    if (k === 'scatter-gather') {
      steps.push(buildMulticastStep(seq, 'Parallel Multicast'));
      continue;
    }

    // ── ForEach → Iterating Splitter ─────────────────────────────────────────
    if (k === 'foreach') {
      const collection = (p.config && p.config.collection) || '#[payload]';
      steps.push(buildSplitterStep(seq, 'Iterating Splitter', collection));
      // Aggregator follows at end of loop
      steps.push(buildAggregatorStep(`${seq}a`, 'Gather'));
      continue;
    }

    // ── Enricher → Content Enricher ──────────────────────────────────────────
    if (k === 'enricher') {
      const target = (p.config && p.config.target) || 'enrichedData';
      steps.push(buildEnricherStep(seq, `Enrich: ${target}`, target));
      continue;
    }

    // ── flow-ref → Process Call ──────────────────────────────────────────────
    if (k === 'flow-ref') {
      const flowName = (p.config && p.config.flowName) || 'SubFlow';
      steps.push(buildProcessCallStep(seq, `Call: ${flowName}`, flowName));
      continue;
    }

    // ── set-payload / set-variable → Content Modifier ───────────────────────
    if (k === 'set-payload' || k === 'set-variable' || k === 'set-property') {
      const val   = (p.config && p.config.value) || '';
      const name  = (p.config && p.config.name) || 'payload';
      const store = k === 'set-variable' ? 'Exchange Property' : k === 'set-property' ? 'Message Header' : 'Message Body';
      steps.push(buildContentModifierStep(seq, p.label || 'Set Payload', `CM_${seq}`, name, val, store));
      continue;
    }

    // ── apikit:router → note step (fan-out handled at project level) ─────────
    if (k === 'apikit:router' || k === 'router') {
      steps.push(buildNoteStep(seq, 'APIKit Router', 'Routes to separate iFlows per HTTP operation. See conversion notes.'));
      continue;
    }

    // ── Error handlers → collected as exception subprocesses (handled separately)
    if (k.includes('exception-strategy') || k.includes('error-handler') || k.includes('on-error')) {
      continue; // Built as exception subprocess in buildExceptionSubprocesses()
    }

    // ── Logger → Content Modifier (trace) ────────────────────────────────────
    if (k === 'logger') {
      steps.push(buildContentModifierStep(seq, p.label || 'Log', `CM_LOG_${seq}`, 'X-Log-Step', p.label || 'trace', 'Message Header'));
      continue;
    }
  }

  return steps;
}

// ── Classify processor types ──────────────────────────────────────────────────
function isSenderElement(k) {
  return k === 'http:listener' || k === 'listener' || k.includes('inbound-endpoint') ||
         k === 'scheduler' || k === 'fixed-frequency' || k.includes('poll') ||
         (k.includes('jms') && k.includes('listener')) ||
         (k.includes('sftp') && k.includes('inbound'));
}

function isReceiverConnector(k) {
  return k.includes('http:request') || k.includes('http:outbound') ||
         k.includes('db:select') || k.includes('db:insert') || k.includes('db:update') || k.includes('db:delete') ||
         k.includes('sftp:') && !k.includes('inbound') ||
         k.includes('jms:') && !k.includes('listener') ||
         k.includes('sfdc:') || k.includes('salesforce:') ||
         k.includes('sap:') || k.includes('smtp:') || k.includes('cxf:') ||
         k.includes('web-service-consumer') ||
         k.includes('mongo:') || k.includes('workday:') || k.includes('servicenow:');
}

// ── Step Builders ─────────────────────────────────────────────────────────────

function buildContentModifierStep(id, name, label, propName, propValue, location) {
  const safeName  = name.replace(/[<>&"]/g, ' ').substring(0, 60);
  const safeVal   = (propValue || '').replace(/[<>&"]/g, '').substring(0, 100);
  return {
    id, label, _type: 'ContentModifier',
    xml: `<bpmn2:serviceTask id="${id}" name="${safeName}" ifl:type="ContentModifier">
      <bpmn2:extensionElements>
        <ifl:property><key>wrapperElement</key><value>root</value></ifl:property>
        <ifl:property><key>action</key><value>Create</value></ifl:property>
        <ifl:property><key>dataStoreLocation</key><value>${location || 'Message Header'}</value></ifl:property>
        <ifl:property><key>name</key><value>${propName || 'migrated'}</value></ifl:property>
        <ifl:property><key>type</key><value>expression</value></ifl:property>
        <ifl:property><key>value</key><value>${safeVal || 'placeholder'}</value></ifl:property>
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:serviceTask>`
  };
}

function buildScriptStep(id, scriptName, label, scriptMeta) {
  const safeName = scriptName.replace(/[^a-zA-Z0-9_]/g, '_');
  const complexity = scriptMeta ? scriptMeta.complexity || 'simple' : 'simple';
  return {
    id, label, _type: 'Script',
    xml: `<bpmn2:serviceTask id="${id}" name="${safeName}" ifl:type="ScriptActivity">
      <bpmn2:extensionElements>
        <ifl:property><key>script</key><value>ref:${safeName}.groovy</value></ifl:property>
        <ifl:property><key>scriptLanguage</key><value>groovy</value></ifl:property>
        <!-- Migrated from DataWeave 1.0 (MuleSoft 3.8) — complexity: ${complexity} -->
        <!-- Original script preserved in .groovy file as comment block -->
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:serviceTask>`
  };
}

function buildXsltStep(id, name, xslFile) {
  return {
    id, label: name, _type: 'XSLT',
    xml: `<bpmn2:serviceTask id="${id}" name="${name}" ifl:type="XSLTransformation">
      <bpmn2:extensionElements>
        <ifl:property><key>xslName</key><value>${xslFile}</value></ifl:property>
        <ifl:property><key>xslFileSource</key><value>classpath</value></ifl:property>
        <ifl:property><key>outputXMLEncoding</key><value>UTF-8</value></ifl:property>
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:serviceTask>`
  };
}

function buildRouterStep(id, name, conditions, iflowId) {
  const safeName = name.replace(/[<>&"]/g, '').substring(0, 60);
  // Generate route conditions as ifl:property entries
  const routeProps = conditions.slice(0, 5).map((c, i) => {
    const expr = (c.groovy || c.expression || '').replace(/[<>&"]/g, '').substring(0, 200);
    return `        <ifl:property><key>route${i + 1}Condition</key><value>${expr || 'true'}</value></ifl:property>
        <ifl:property><key>route${i + 1}Name</key><value>Route_${i + 1}</value></ifl:property>`;
  }).join('\n');

  return {
    id, label: safeName, _type: 'Router',
    routeCount: conditions.length + 1, // +1 for default
    xml: `<bpmn2:exclusiveGateway id="${id}" name="${safeName}" ifl:type="Router">
      <bpmn2:extensionElements>
        <ifl:property><key>numberOfRoutes</key><value>${conditions.length + 1}</value></ifl:property>
${routeProps}
        <ifl:property><key>defaultRoute</key><value>Default</value></ifl:property>
        <!-- Conditions migrated from MuleSoft &lt;choice&gt; when expressions -->
        <!-- Review Groovy conditions before deploying to IS -->
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      ${conditions.map((_, i) => `<bpmn2:outgoing>SEQ_FROM_${id}_R${i + 1}</bpmn2:outgoing>`).join('\n      ')}
      <bpmn2:outgoing>SEQ_FROM_${id}_DEFAULT</bpmn2:outgoing>
    </bpmn2:exclusiveGateway>`
  };
}

function buildMulticastStep(id, name) {
  return {
    id, label: name, _type: 'Multicast',
    xml: `<bpmn2:parallelGateway id="${id}" name="${name}" ifl:type="Multicast">
      <bpmn2:extensionElements>
        <ifl:property><key>parallelMulticastType</key><value>Parallel</value></ifl:property>
        <ifl:property><key>stopOnException</key><value>false</value></ifl:property>
        <!-- Migrated from MuleSoft &lt;scatter-gather&gt; -->
        <!-- Add parallel branches in IS Integration Designer -->
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}_B1</bpmn2:outgoing>
      <bpmn2:outgoing>SEQ_FROM_${id}_B2</bpmn2:outgoing>
    </bpmn2:parallelGateway>`
  };
}

function buildSplitterStep(id, name, collection) {
  const safeCol = collection.replace(/[<>&"]/g, '').substring(0, 100);
  return {
    id, label: name, _type: 'Splitter',
    xml: `<bpmn2:serviceTask id="${id}" name="${name}" ifl:type="IteratingSplitter">
      <bpmn2:extensionElements>
        <ifl:property><key>expressionType</key><value>XPath</value></ifl:property>
        <ifl:property><key>expression</key><value>${safeCol}</value></ifl:property>
        <ifl:property><key>stopOnException</key><value>false</value></ifl:property>
        <!-- Migrated from MuleSoft &lt;foreach collection="${safeCol}"&gt; -->
        <!-- Update XPath expression to match actual message structure -->
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

function buildEnricherStep(id, name, target) {
  return {
    id, label: name, _type: 'ContentEnricher',
    xml: `<bpmn2:serviceTask id="${id}" name="${name}" ifl:type="ContentEnricher">
      <bpmn2:extensionElements>
        <ifl:property><key>enricherTargetVariable</key><value>${target}</value></ifl:property>
        <!-- Migrated from MuleSoft &lt;enricher target="#[flowVars.${target}]"&gt; -->
        <!-- Configure sub-process call or lookup in IS Integration Designer -->
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:serviceTask>`
  };
}

function buildProcessCallStep(id, name, flowName) {
  const safeName  = name.replace(/[<>&"]/g, '').substring(0, 60);
  const safeFlow  = flowName.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return {
    id, label: safeName, _type: 'ProcessCall',
    xml: `<bpmn2:callActivity id="${id}" name="${safeName}" ifl:type="ProcessCall">
      <bpmn2:extensionElements>
        <ifl:property><key>localWsdlBinding</key><value>${safeFlow}</value></ifl:property>
        <!-- Migrated from MuleSoft &lt;flow-ref name="${flowName}"/&gt; -->
        <!-- Create a corresponding Process Direct iFlow named "${safeFlow}" -->
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:callActivity>`
  };
}

function buildCallStep(id, name, config, isReceiver) {
  const safeName = name.replace(/[<>&"]/g, '').substring(0, 60);
  return {
    id, label: safeName, _type: 'RequestReply', _isReceiver: isReceiver,
    xml: `<bpmn2:serviceTask id="${id}" name="${safeName}" ifl:type="RequestReply">
      <bpmn2:extensionElements>
        <!-- Outbound call — adapter configured on receiver channel -->
        ${config.sql ? `<ifl:property><key>jdbcQuery</key><value>${config.sql.replace(/[<>&"]/g, ' ').substring(0, 200)}</value></ifl:property>` : ''}
        ${config.path ? `<ifl:property><key>httpPath</key><value>${config.path}</value></ifl:property>` : ''}
        ${config.method ? `<ifl:property><key>httpMethod</key><value>${config.method}</value></ifl:property>` : ''}
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
        <ifl:property><key>name</key><value>X-Migration-Note</key></ifl:property>
        <ifl:property><key>value</key><value>${note.replace(/[<>&"]/g, ' ')}</value></ifl:property>
        <!-- ${note} -->
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_${id}</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_${id}</bpmn2:outgoing>
    </bpmn2:serviceTask>`
  };
}

// ── Exception subprocesses from error handlers ─────────────────────────────
function buildExceptionSubprocesses(errorHandlers, artifact, iflowId) {
  if (!errorHandlers || errorHandlers.length === 0) return '';

  return errorHandlers.map((eh, i) => {
    const subId = `ExcSub_${i + 1}_${iflowId}`;
    const condition = eh.condition ? eh.condition.replace(/[<>&"]/g, '').substring(0, 100) : null;
    return `
    <!-- ── Exception Sub-process ${i + 1} (migrated from ${eh.type === 'choice' ? 'choice-exception-strategy' : 'catch-exception-strategy'}) ── -->
    <bpmn2:subProcess id="${subId}" name="Exception Handling ${i + 1}" triggeredByEvent="true" isForCompensation="false">
      <bpmn2:extensionElements>
        <ifl:property><key>activityType</key><value>ExceptionSubprocess</value></ifl:property>
        ${condition ? `<ifl:property><key>errorMatchCondition</key><value>${condition}</value></ifl:property>` : ''}
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
          <ifl:property><key>value</key><value>exception-strategy-${i + 1}</value></ifl:property>
          <!-- TODO: Set appropriate HTTP response status and error body here -->
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

// ── Sequence flow builder ─────────────────────────────────────────────────────
function buildSequenceFlowsFromSteps(steps, iflowId) {
  if (!steps.length) {
    return `<bpmn2:sequenceFlow id="SEQ_Start_End" sourceRef="StartEvent_${iflowId}" targetRef="EndEvent_${iflowId}" name=""/>`;
  }

  const flows = [];
  // Start → first step
  flows.push(`<bpmn2:sequenceFlow id="SEQ_Start_To_${steps[0].id}" sourceRef="StartEvent_${iflowId}" targetRef="${steps[0].id}" name=""/>`);

  // Step → step
  for (let i = 0; i < steps.length - 1; i++) {
    const curr = steps[i];
    const next = steps[i + 1];
    const srcFlow = curr._type === 'Router' ? `SEQ_FROM_${curr.id}_DEFAULT` : `SEQ_FROM_${curr.id}`;
    flows.push(`<bpmn2:sequenceFlow id="${srcFlow}" sourceRef="${curr.id}" targetRef="${next.id}" name=""/>`);
    // For TO_ references in the step XML
    flows.push(`<!-- link: SEQ_TO_${next.id} -->`);
  }

  // Last step → End
  const last = steps[steps.length - 1];
  flows.push(`<bpmn2:sequenceFlow id="SEQ_FROM_${last.id}" sourceRef="${last.id}" targetRef="EndEvent_${iflowId}" name=""/>`);

  // Fix up incoming references in step XML: SEQ_TO_X needs to match the outgoing from previous
  return flows.join('\n    ');
}

// ── Full BPMN2 XML builder for MuleSoft artifacts ─────────────────────────────
function buildMuleSoftBPMN(artifact, platformData, iflowId, iflowName, senderAdapter, receiverAdapter) {
  const domain      = artifact.domain || 'INT';
  const processors  = platformData.processors || [];
  const errorHandlers = platformData.errorHandlers || [];
  const hasErrors   = errorHandlers.length > 0 || artifact.error_handling !== 'none';

  // Build steps from processor list
  const steps = buildStepsFromProcessors(processors, artifact, iflowId, platformData);

  // Add a context header CM at start if no other CMs exist
  if (!steps.some(s => s._type === 'ContentModifier')) {
    steps.unshift({
      id: 'cm_ctx', label: 'Set Context', _type: 'ContentModifier',
      xml: `<bpmn2:serviceTask id="cm_ctx" name="Set Migration Context" ifl:type="ContentModifier">
      <bpmn2:extensionElements>
        <ifl:property><key>action</key><value>Create</value></ifl:property>
        <ifl:property><key>dataStoreLocation</key><value>Message Header</value></ifl:property>
        <ifl:property><key>name</key><value>X-Source-Platform</value></ifl:property>
        <ifl:property><key>type</key><value>expression</value></ifl:property>
        <ifl:property><key>value</key><value>MULESOFT</value></ifl:property>
      </bpmn2:extensionElements>
      <bpmn2:incoming>SEQ_TO_cm_ctx</bpmn2:incoming>
      <bpmn2:outgoing>SEQ_FROM_cm_ctx</bpmn2:outgoing>
    </bpmn2:serviceTask>`
    });
  }

  const stepsXml  = steps.map(s => '    ' + s.xml).join('\n\n');
  const seqFlows  = buildSequenceFlowsFromSteps(steps, iflowId);
  const excSubs   = hasErrors ? buildExceptionSubprocesses(errorHandlers, artifact, iflowId) : '';

  // Build step summary comment
  const stepSummary = steps.map((s, i) => `     Step ${i + 1}: [${s._type}] ${s.label}`).join('\n');

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
    Source: MULESOFT — ${artifact.name}
    Domain: ${domain} | Trigger: ${artifact.trigger_type || 'API'} | Complexity: ${artifact.complexity_level || 'Medium'}
    Connectors: ${(platformData.connectorTypes || []).join(', ') || 'HTTP'}
    Completeness: ${platformData.completenessScore || 80}%
    Generated: ${new Date().toISOString()}
    Sierra Digital — IS Migration Tool (S3+S4)

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
        ${buildReceiverExtensionsFromConfig(platformData, artifact)}
      </bpmn2:extensionElements>
    </bpmn2:participant>

    <bpmn2:messageFlow id="MF_Sender_To_Process"
        sourceRef="Sender" targetRef="StartEvent_${iflowId}"
        name="${senderAdapter}" ifl:type="senderChannel">
      <bpmn2:extensionElements>
        ${buildSenderExtensionsFromConfig(platformData, artifact)}
      </bpmn2:extensionElements>
    </bpmn2:messageFlow>

    <bpmn2:messageFlow id="MF_Process_To_Receiver"
        sourceRef="EndEvent_${iflowId}" targetRef="Receiver"
        name="${receiverAdapter}" ifl:type="receiverChannel">
      <bpmn2:extensionElements>
        ${buildReceiverChannelFromConfig(platformData, artifact)}
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

// ── Channel extension builders from real config ─────────────────────────────
function buildSenderExtensionsFromConfig(pd, artifact) {
  const sender = pd.senderConfig || {};
  const type   = sender.type || artifact.trigger_type || 'API';

  if (type === 'Timer' || type === 'Schedule') {
    const freq = sender.frequency || '60000';
    const unit = (sender.timeUnit || 'MILLISECONDS').toLowerCase();
    const secs = unit === 'milliseconds' ? Math.round(parseInt(freq) / 1000) : parseInt(freq);
    return `<ifl:property><key>adapterType</key><value>scheduler</value></ifl:property>
        <ifl:property><key>cronExpression</key><value>0 0/{{SCHEDULER_INTERVAL_MINS}} * * * ?</value></ifl:property>
        <ifl:property><key>schedulerType</key><value>fixedRate</value></ifl:property>
        <ifl:property><key>schedulerInterval</key><value>${secs}</value></ifl:property>
        <ifl:property><key>schedulerIntervalUnit</key><value>Second</value></ifl:property>`;
  }
  if (type === 'JMS' || type === 'Event') {
    const queue = sender.queue || '{{JMS_QUEUE_NAME}}';
    return `<ifl:property><key>adapterType</key><value>jms</value></ifl:property>
        <ifl:property><key>queueName</key><value>${queue}</value></ifl:property>
        <ifl:property><key>connectionFactory</key><value>{{param.jms.connection.factory}}</value></ifl:property>`;
  }
  if (type === 'SFTP' || type === 'Listener') {
    const dir  = sender.directory || '/inbound';
    const host = sender.host || '{{param.sftp.host}}';
    return `<ifl:property><key>adapterType</key><value>sftp</value></ifl:property>
        <ifl:property><key>directoryName</key><value>${dir}</value></ifl:property>
        <ifl:property><key>hostName</key><value>${host}</value></ifl:property>
        <ifl:property><key>port</key><value>22</value></ifl:property>`;
  }
  // Default: HTTP
  const path    = sender.path || `/http/${artifact.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  const methods = sender.methods || 'POST';
  return `<ifl:property><key>adapterType</key><value>http</value></ifl:property>
        <ifl:property><key>address</key><value>{{param.sender.address}}</value></ifl:property>
        <ifl:property><key>httpPath</key><value>${path}</value></ifl:property>
        <ifl:property><key>allowedMethods</key><value>${methods}</value></ifl:property>
        <ifl:property><key>userRole</key><value>ESBMessaging.send</value></ifl:property>`;
}

function buildReceiverExtensionsFromConfig(pd, artifact) {
  const rc = pd.receiverConfigs && pd.receiverConfigs[0];
  if (!rc) return `<ifl:property><key>adapterType</key><value>http</value></ifl:property>`;
  return `<ifl:property><key>adapterType</key><value>${rc.type.toLowerCase()}</value></ifl:property>`;
}

function buildReceiverChannelFromConfig(pd, artifact) {
  const rc = pd.receiverConfigs && pd.receiverConfigs[0];
  if (!rc) {
    return `<ifl:property><key>adapterType</key><value>http</value></ifl:property>
        <ifl:property><key>address</key><value>{{param.receiver.http.address}}</value></ifl:property>`;
  }

  switch (rc.type) {
    case 'JDBC':
      return `<ifl:property><key>adapterType</key><value>jdbc</value></ifl:property>
        <ifl:property><key>dataSourceAlias</key><value>{{param.receiver.jdbc.datasource}}</value></ifl:property>
        ${rc.sql ? `<ifl:property><key>query</key><value>${rc.sql.replace(/[<>&"]/g, ' ').substring(0, 500)}</value></ifl:property>` : ''}
        <ifl:property><key>operation</key><value>${rc.operation || 'SELECT'}</value></ifl:property>`;
    case 'JMS':
      return `<ifl:property><key>adapterType</key><value>jms</value></ifl:property>
        <ifl:property><key>queueName</key><value>${rc.queue || '{{param.jms.queue.name}}'}</value></ifl:property>
        <ifl:property><key>connectionFactory</key><value>{{param.jms.connection.factory}}</value></ifl:property>`;
    case 'SFTP':
      return `<ifl:property><key>adapterType</key><value>sftp</value></ifl:property>
        <ifl:property><key>hostName</key><value>${rc.host || '{{param.receiver.sftp.host}}'}</value></ifl:property>
        <ifl:property><key>directoryName</key><value>${rc.path || '/outbound'}</value></ifl:property>
        <ifl:property><key>fileName</key><value>${rc.outputPattern || '${header.CamelFileName}'}</value></ifl:property>`;
    case 'Salesforce':
      return `<ifl:property><key>adapterType</key><value>salesforce</value></ifl:property>
        <ifl:property><key>address</key><value>{{param.receiver.salesforce.address}}</value></ifl:property>
        <ifl:property><key>objectName</key><value>${rc.sobject || '{{SF_OBJECT}}'}</value></ifl:property>
        <ifl:property><key>operation</key><value>${rc.operation || 'query'}</value></ifl:property>`;
    case 'IDoc':
    case 'RFC':
    case 'SAP':
      return `<ifl:property><key>adapterType</key><value>${rc.type.toLowerCase()}</value></ifl:property>
        <ifl:property><key>sapHost</key><value>{{param.receiver.sap.rfc.host}}</value></ifl:property>
        <ifl:property><key>functionName</key><value>${rc.function || '{{SAP_FUNCTION}}'}</value></ifl:property>`;
    case 'Mail':
    case 'SMTP':
      return `<ifl:property><key>adapterType</key><value>mail</value></ifl:property>
        <ifl:property><key>smtpHost</key><value>${rc.host || '{{param.receiver.mail.host}}'}</value></ifl:property>
        <ifl:property><key>from</key><value>${rc.from || '{{FROM_EMAIL}}'}</value></ifl:property>
        <ifl:property><key>to</key><value>${rc.to || '{{TO_EMAIL}}'}</value></ifl:property>
        <ifl:property><key>subject</key><value>${(rc.subject || '').replace(/[<>&"]/g, ' ')}</value></ifl:property>`;
    case 'SOAP':
      return `<ifl:property><key>adapterType</key><value>soap</value></ifl:property>
        <ifl:property><key>wsdlUrl</key><value>${rc.wsdl || '{{WSDL_URL}}'}</value></ifl:property>
        <ifl:property><key>operationName</key><value>${rc.operation || '{{SOAP_OPERATION}}'}</value></ifl:property>`;
    default:
      return `<ifl:property><key>adapterType</key><value>http</value></ifl:property>
        <ifl:property><key>address</key><value>{{param.receiver.http.address}}</value></ifl:property>
        <ifl:property><key>httpMethod</key><value>${rc.method || 'POST'}</value></ifl:property>
        <ifl:property><key>httpPath</key><value>${rc.path || '/'}</value></ifl:property>`;
  }
}

module.exports = {
  buildMuleSoftBPMN,
  buildStepsFromProcessors,
  buildExceptionSubprocesses
};
