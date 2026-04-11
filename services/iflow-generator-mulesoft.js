'use strict';
/**
 * MuleSoft → SAP IS iFlow Generator (Sprint 3–6)
 *
 * Reads artifact.raw_xml (the real <flow> XML block stored during parse)
 * and extracts:
 *   - Real connector elements with actual config (host, path, operation, queue names)
 *   - DataWeave 1.0 scripts from <dw:transform-message> CDATA blocks
 *   - Flow control structure (choice, foreach, scatter-gather, enricher)
 *   - Error handling (catch-exception-strategy, choice-exception-strategy)
 *   - APIKit routing (one iFlow per HTTP operation)
 *
 * Returns a rich platformData object compatible with engine/iflow.js +
 * engine/conversion.js, plus conversion_notes and completeness score.
 */

const xml2js = require('xml2js');

// ── Main entry: extract real platform data from MuleSoft raw_xml ─────────────
async function extractMuleSoftPlatformData(artifact) {
  if (!artifact.raw_xml) return buildFallbackPlatformData(artifact);

  try {
    const parser = new xml2js.Parser({
      explicitArray: true,
      ignoreAttrs: false,
      tagNameProcessors: [xml2js.processors.stripPrefix]
    });
    const doc = await parser.parseStringPromise(artifact.raw_xml);
    return analyseFlowDoc(doc, artifact);
  } catch (e) {
    console.warn(`[MuleSoft Generator] XML parse error for ${artifact.name}:`, e.message);
    return buildFallbackPlatformData(artifact);
  }
}

// ── Analyse the parsed flow XML doc ─────────────────────────────────────────
function analyseFlowDoc(doc, artifact) {
  // Root may be a <flow> element directly or a <mule> root
  const flowEl = doc['flow'] || doc['batch:job'] || doc['batch-job'];
  const muleEl = doc['mule'];

  // Build a map: connectorName (from 'name' attr) → connector type
  // and a map: flowName → flow element (for flow-ref resolution)
  const globalConnectorMap = {};   // e.g. { 'Gmail': 'SMTP', 'HTTP_Listener_Configuration': 'HTTP' }
  const siblingFlowMap     = {};   // e.g. { 'outboundFlow': <flowEl> }

  let flow = null;
  if (flowEl) {
    flow = Array.isArray(flowEl) ? flowEl[0] : flowEl;
  } else if (muleEl) {
    const root = Array.isArray(muleEl) ? muleEl[0] : muleEl;

    // ── Collect global connector configs from mule root ───────────────────────
    // After stripPrefix: smtp:gmail-connector → 'gmail-connector'
    //                    http:listener-config  → 'listener-config'
    //                    jms:activemq-connector → 'activemq-connector'
    for (const [k, els] of Object.entries(root)) {
      if (k === '$') continue;
      const kl = k.toLowerCase();
      const cfgType =
        (kl.includes('gmail') || kl.includes('smtp'))                         ? 'SMTP'       :
        (kl.includes('listener-config') || kl === 'http:connector')           ? 'HTTP'       :
        (kl.includes('jms') || kl.includes('activemq') || kl.includes('ems')) ? 'JMS'        :
        (kl.includes('sftp') && !kl.includes('inbound'))                      ? 'SFTP'       :
        (kl.includes('sfdc') || kl.includes('salesforce'))                    ? 'Salesforce' :
        (kl.includes('sap'))                                                   ? 'SAP'        :
        (kl.includes('jdbc') || kl.includes('db:generic'))                    ? 'JDBC'       :
        (kl.includes('cxf') || kl.includes('ws-consumer'))                    ? 'SOAP'       :
        (kl.includes('mongodb'))                                               ? 'MongoDB'    : null;
      if (cfgType) {
        const arr = Array.isArray(els) ? els : [els];
        for (const el of arr) {
          const attrs = (el && el['$']) ? el['$'] : {};
          const name  = attrs.name || attrs['doc:name'];
          if (name) globalConnectorMap[name] = cfgType;
        }
      }
    }

    // ── Collect all flows into a map for flow-ref resolution ─────────────────
    const flows = root['flow'] || [];
    for (const f of (Array.isArray(flows) ? flows : [flows])) {
      const attrs = (f && f['$']) ? f['$'] : {};
      if (attrs.name) siblingFlowMap[attrs.name] = f;
    }
    // Also sub-flows
    const subFlows = root['sub-flow'] || [];
    for (const f of (Array.isArray(subFlows) ? subFlows : [subFlows])) {
      const attrs = (f && f['$']) ? f['$'] : {};
      if (attrs.name) siblingFlowMap[attrs.name] = f;
    }

    // Find the primary flow for this artifact
    flow = siblingFlowMap[artifact.name] ||
           flows.find(f => { const a = f['$'] || {}; return a.name === artifact.name; }) ||
           (Array.isArray(flows) ? flows[0] : flows);
  }

  if (!flow) return buildFallbackPlatformData(artifact);

  const result = {
    processors:        [],
    connectorTypes:    [],
    iflowAdapters:     [],
    dataWeaveTransforms: [],
    scripts:           [],
    flowControlSteps:  [],
    errorHandlers:     [],
    senderConfig:      null,
    receiverConfigs:   [],
    conversionNotes:   [],
    completenessScore: 100,
    _globalConnectorMap: globalConnectorMap,
    _siblingFlowMap:     siblingFlowMap,
    _walkedFlows:        new Set()   // prevent infinite loops on circular flow-refs
  };

  walkFlowElement(flow, result, artifact);
  deriveAdapterList(result, artifact);
  calculateCompleteness(result);

  // Clean up internal tracking fields
  delete result._globalConnectorMap;
  delete result._siblingFlowMap;
  delete result._walkedFlows;

  return result;
}

// ── Recursively walk flow XML elements ───────────────────────────────────────
function walkFlowElement(node, result, artifact) {
  if (!node || typeof node !== 'object') return;

  const keys = Object.keys(node).filter(k => k !== '$');
  for (const key of keys) {
    const els = Array.isArray(node[key]) ? node[key] : [node[key]];
    const k   = key.toLowerCase();

    // ── Sender / Trigger detection ────────────────────────────────────────────
    if (k === 'listener' || k.includes('http:listener')) {
      for (const el of els) {
        const attrs   = (el && el['$']) ? el['$'] : {};
        const cfgRef  = attrs['config-ref'] || attrs.configRef || '';
        const path    = attrs.path || '/';
        const methods = attrs.allowedMethods || 'GET,POST,PUT,DELETE';
        result.senderConfig = { type: 'HTTP', path, methods, configRef: cfgRef };
        result.processors.push({ type: 'http:listener', label: `HTTP Listener: ${path}`, config: { path, methods } });
      }
    }

    if (k === 'scheduler' || k.includes('poll') || k === 'fixed-frequency') {
      for (const el of els) {
        const attrs    = (el && el['$']) ? el['$'] : {};
        const freq     = attrs.frequency || '60000';
        const timeUnit = attrs.timeUnit || 'MILLISECONDS';
        result.senderConfig = { type: 'Timer', frequency: freq, timeUnit };
        result.processors.push({ type: 'scheduler', label: `Timer: every ${freq} ${timeUnit}` });
      }
    }

    if (k.includes('jms') && (k.includes('listener') || k.includes('inbound'))) {
      for (const el of els) {
        const attrs = (el && el['$']) ? el['$'] : {};
        const queue = attrs.queue || attrs.destination || '{{JMS_QUEUE}}';
        result.senderConfig = { type: 'JMS', queue };
        result.processors.push({ type: 'jms:listener', label: `JMS Listener: ${queue}`, config: { queue } });
      }
    }

    if (k.includes('file') && k.includes('inbound')) {
      for (const el of els) {
        const attrs = (el && el['$']) ? el['$'] : {};
        result.senderConfig = { type: 'SFTP', directory: attrs.path || '/inbound' };
        result.processors.push({ type: 'file:inbound-endpoint', label: `File Poller: ${attrs.path || '/inbound'}` });
      }
    }

    if (k.includes('sftp') && k.includes('inbound')) {
      for (const el of els) {
        const attrs = (el && el['$']) ? el['$'] : {};
        result.senderConfig = { type: 'SFTP', host: attrs.host || '{{SFTP_HOST}}', directory: attrs.path || '/inbound' };
        result.processors.push({ type: 'sftp:inbound-endpoint', label: `SFTP Listener: ${attrs.host || ''}${attrs.path || ''}` });
      }
    }

    // ── Outbound connector detection ─────────────────────────────────────────

    if (k.includes('http:request') || k.includes('http:outbound') || k === 'request') {
      for (const el of els) {
        const attrs  = (el && el['$']) ? el['$'] : {};
        const path   = attrs.path || '/';
        const method = attrs.method || 'POST';
        const cfg    = { type: 'HTTP', path, method, configRef: attrs['config-ref'] || '' };
        result.receiverConfigs.push(cfg);
        result.processors.push({ type: 'http:request', label: `HTTP ${method}: ${path}`, config: cfg });
        if (!result.connectorTypes.includes('HTTP')) result.connectorTypes.push('HTTP');
      }
    }

    if (k.includes('db:select') || k.includes('db:insert') || k.includes('db:update') || k.includes('db:delete') || k.includes('db:stored-procedure')) {
      for (const el of els) {
        const attrs = (el && el['$']) ? el['$'] : {};
        // Extract SQL query
        const queryEl = el['parameterized-query'] || el['template-query-ref'] || el['dynamic-query'] || [];
        const sql = (queryEl[0] && typeof queryEl[0] === 'string') ? queryEl[0].trim() :
                    (queryEl[0] && queryEl[0]['_']) ? queryEl[0]['_'].trim() : null;
        const cfg = { type: 'JDBC', operation: k.includes('select') ? 'SELECT' : k.includes('insert') ? 'INSERT' : k.includes('update') ? 'UPDATE' : 'EXECUTE', sql, configRef: attrs['config-ref'] || '' };
        result.receiverConfigs.push(cfg);
        result.processors.push({ type: key, label: `JDBC ${cfg.operation}${sql ? ': ' + sql.substring(0, 50).replace(/\n/g, ' ') : ''}`, config: cfg });
        if (!result.connectorTypes.includes('JDBC')) result.connectorTypes.push('JDBC');
      }
    }

    if (k.includes('sftp:') && !k.includes('inbound') && !k.includes('listener')) {
      for (const el of els) {
        const attrs = (el && el['$']) ? el['$'] : {};
        const cfg = { type: 'SFTP', host: attrs.host || '{{SFTP_HOST}}', path: attrs.path || '/outbound', outputPattern: attrs.outputPattern || attrs.filename || '' };
        result.receiverConfigs.push(cfg);
        result.processors.push({ type: 'sftp:outbound-endpoint', label: `SFTP Upload: ${cfg.path}`, config: cfg });
        if (!result.connectorTypes.includes('SFTP')) result.connectorTypes.push('SFTP');
      }
    }

    if (k.includes('jms:') && !k.includes('inbound') && !k.includes('listener')) {
      for (const el of els) {
        const attrs = (el && el['$']) ? el['$'] : {};
        const queue = attrs.queue || attrs.destination || '{{JMS_QUEUE}}';
        const cfg   = { type: 'JMS', queue, configRef: attrs['config-ref'] || '' };
        result.receiverConfigs.push(cfg);
        result.processors.push({ type: 'jms:outbound-endpoint', label: `JMS Send: ${queue}`, config: cfg });
        if (!result.connectorTypes.includes('JMS')) result.connectorTypes.push('JMS');
      }
    }

    if (k.includes('sfdc:') || k.includes('salesforce:')) {
      for (const el of els) {
        const attrs     = (el && el['$']) ? el['$'] : {};
        const operation = k.split(':')[1] || 'query';
        const sobject   = attrs.type || attrs.sObjectType || attrs.objectType || '{{SF_OBJECT}}';
        const cfg       = { type: 'Salesforce', operation, sobject, configRef: attrs['config-ref'] || '' };
        result.receiverConfigs.push(cfg);
        result.processors.push({ type: key, label: `Salesforce ${operation}: ${sobject}`, config: cfg });
        if (!result.connectorTypes.includes('Salesforce')) result.connectorTypes.push('Salesforce');
      }
    }

    if (k.includes('sap:')) {
      for (const el of els) {
        const attrs    = (el && el['$']) ? el['$'] : {};
        const sapType  = attrs.type || 'function';
        const funcName = attrs.functionName || attrs.idocType || '{{SAP_FUNCTION}}';
        const cfg      = { type: sapType === 'idoc' ? 'IDoc' : 'RFC', function: funcName, configRef: attrs['config-ref'] || '' };
        result.receiverConfigs.push(cfg);
        result.processors.push({ type: key, label: `SAP ${cfg.type}: ${funcName}`, config: cfg });
        if (!result.connectorTypes.includes('SAP')) result.connectorTypes.push('SAP');
      }
    }

    if (k.includes('smtp:') || k.includes('email:')) {
      for (const el of els) {
        const attrs = (el && el['$']) ? el['$'] : {};
        const cfg   = { type: 'Mail', from: attrs.from || '{{FROM_EMAIL}}', to: attrs.to || '{{TO_EMAIL}}', subject: attrs.subject || '', host: attrs.host || '{{SMTP_HOST}}' };
        result.receiverConfigs.push(cfg);
        result.processors.push({ type: key, label: `Email: ${cfg.subject || cfg.to}`, config: cfg });
        if (!result.connectorTypes.includes('SMTP')) result.connectorTypes.push('SMTP');
      }
    }

    if (k.includes('cxf:') || k.includes('web-service-consumer')) {
      for (const el of els) {
        const attrs   = (el && el['$']) ? el['$'] : {};
        const wsdl    = attrs.wsdlLocation || attrs.wsdlUrl || '{{WSDL_URL}}';
        const op      = attrs.operation || attrs.operation || '{{SOAP_OPERATION}}';
        const cfg     = { type: 'SOAP', wsdl, operation: op };
        result.receiverConfigs.push(cfg);
        result.processors.push({ type: key, label: `SOAP: ${op}`, config: cfg });
        if (!result.connectorTypes.includes('SOAP')) result.connectorTypes.push('SOAP');
      }
    }

    if (k.includes('mongo:') || k.includes('mongodb:')) {
      for (const el of els) {
        const attrs = (el && el['$']) ? el['$'] : {};
        const op    = k.split(':')[1] || 'query';
        result.processors.push({ type: key, label: `MongoDB ${op}`, config: { type: 'MongoDB', operation: op } });
        if (!result.connectorTypes.includes('MongoDB')) result.connectorTypes.push('MongoDB');
        result.conversionNotes.push({
          type: 'UNMAPPED_CONNECTOR',
          element: key,
          severity: 'warning',
          suggestion: 'MongoDB has no native SAP IS adapter. Use HTTPS Receiver Adapter with MongoDB Atlas Data API (https://data.mongodb-api.com/app/data-/endpoint/data/v1/action/' + op + ')'
        });
      }
    }

    if (k.includes('workday:')) {
      for (const el of els) {
        result.processors.push({ type: key, label: `Workday: ${k.split(':')[1] || 'operation'}` });
        if (!result.connectorTypes.includes('Workday')) result.connectorTypes.push('Workday');
        result.conversionNotes.push({ type: 'UNMAPPED_CONNECTOR', element: key, severity: 'info', suggestion: 'Use HTTPS Receiver Adapter with Workday REST API endpoint' });
      }
    }

    if (k.includes('servicenow:')) {
      for (const el of els) {
        result.processors.push({ type: key, label: `ServiceNow: ${k.split(':')[1] || 'operation'}` });
        if (!result.connectorTypes.includes('ServiceNow')) result.connectorTypes.push('ServiceNow');
        result.conversionNotes.push({ type: 'UNMAPPED_CONNECTOR', element: key, severity: 'info', suggestion: 'Use HTTPS Receiver Adapter with ServiceNow REST Table API' });
      }
    }

    // ── DataWeave transforms ──────────────────────────────────────────────────
    if (k === 'transform-message' || k === 'transform' || k === 'ee:transform') {
      for (const el of els) {
        const dwScript = extractDataWeaveScript(el);
        if (dwScript) {
          const complexity = assessDwComplexity(dwScript.body);
          result.dataWeaveTransforms.push(dwScript);
          result.scripts.push({ type: 'dataweave', name: `${artifact.name}_Transform_${result.dataWeaveTransforms.length}`, ...dwScript, complexity });
          result.processors.push({ type: key, label: `DataWeave Transform #${result.dataWeaveTransforms.length}`, config: { hasScript: true, complexity } });
          if (complexity === 'complex') {
            result.conversionNotes.push({
              type: 'SCRIPTING_PRESERVED', element: key, severity: 'info',
              suggestion: 'Complex DataWeave script preserved in Groovy stub — implement equivalent logic in SAP IS',
              script: dwScript.body.substring(0, 200)
            });
          }
        }
      }
    }

    // ── Flow control ──────────────────────────────────────────────────────────
    if (k === 'choice') {
      for (const el of els) {
        const conditions = extractChoiceConditions(el);
        result.flowControlSteps.push({ type: 'Router', conditions, branches: conditions.length + 1 });
        result.processors.push({ type: 'choice', label: `Router (${conditions.length} conditions + default)`, config: { conditions } });
      }
    }

    if (k === 'scatter-gather') {
      for (const el of els) {
        const hasCustomAgg = el['custom-aggregation-strategy'] || el['aggregation-strategy'];
        result.flowControlSteps.push({ type: 'Multicast', customAggregation: !!hasCustomAgg });
        result.processors.push({ type: 'scatter-gather', label: 'Parallel Multicast' });
        if (hasCustomAgg) {
          result.conversionNotes.push({
            type: 'SCRIPTING_PRESERVED', element: 'custom-aggregation-strategy', severity: 'warning',
            suggestion: 'Custom aggregation strategy (Java class) must be reimplemented as Groovy in IS exception sub-process'
          });
        }
      }
    }

    if (k === 'foreach') {
      for (const el of els) {
        const attrs      = (el && el['$']) ? el['$'] : {};
        const collection = attrs.collection || '#[payload]';
        result.flowControlSteps.push({ type: 'IteratingSplitter', collection });
        result.processors.push({ type: 'foreach', label: `For Each: ${collection}`, config: { collection } });
      }
    }

    if (k === 'enricher') {
      for (const el of els) {
        const attrs  = (el && el['$']) ? el['$'] : {};
        const target = (attrs.target || '#[flowVars.enriched]').replace('#[flowVars.', '').replace(']', '');
        result.flowControlSteps.push({ type: 'ContentEnricher', target });
        result.processors.push({ type: 'enricher', label: `Enrich → ${target}`, config: { target } });
      }
    }

    if (k === 'flow-ref') {
      for (const el of els) {
        const attrs      = (el && el['$']) ? el['$'] : {};
        const name       = attrs.name || '{{SUB_FLOW}}';
        result.processors.push({ type: 'flow-ref', label: `Call: ${name}`, config: { flowName: name } });
        // Walk referenced flow to capture its connectors (avoid infinite loops)
        if (name && result._siblingFlowMap && result._siblingFlowMap[name] && !result._walkedFlows.has(name)) {
          result._walkedFlows.add(name);
          walkFlowElement(result._siblingFlowMap[name], result, artifact);
        }
      }
    }

    // ── Generic outbound-endpoint (prefix stripped by xml2js — e.g. smtp:, jms:, file:) ──
    if (k === 'outbound-endpoint') {
      for (const el of els) {
        const attrs      = (el && el['$']) ? el['$'] : {};
        const connRef    = attrs['connector-ref'] || attrs.connectorRef || '';
        const host       = attrs.host || '';
        const queue      = attrs.queue || attrs.destination || '';
        // Resolve type from global connector map → connector-ref attr → element signals
        let connType =
          (result._globalConnectorMap && result._globalConnectorMap[connRef]) ||
          (connRef.toLowerCase().includes('gmail') || connRef.toLowerCase().includes('smtp') ? 'SMTP' : null) ||
          (connRef.toLowerCase().includes('jms') || connRef.toLowerCase().includes('activemq') ? 'JMS' : null) ||
          (queue ? 'JMS' : null) ||
          (host && !queue ? 'SMTP' : null) ||
          'Generic';
        const cfg = { type: connType, connectorRef: connRef, host, queue };
        result.receiverConfigs.push(cfg);
        result.processors.push({ type: 'outbound-endpoint', label: `${connType} Outbound: ${connRef || queue || host || 'endpoint'}`, config: cfg });
        if (!result.connectorTypes.includes(connType)) result.connectorTypes.push(connType);
        // Add SMTP-specific note
        if (connType === 'SMTP') {
          result.conversionNotes.push({
            type: 'CONNECTOR_MAPPED', element: 'smtp:outbound-endpoint', severity: 'info',
            suggestion: 'SMTP → SAP IS Mail Receiver Adapter. Configure SMTP host, port, credentials in IS channel.'
          });
        }
      }
    }

    // ── Payload / variable manipulation ──────────────────────────────────────
    if (k === 'set-payload') {
      for (const el of els) {
        const attrs = (el && el['$']) ? el['$'] : {};
        result.processors.push({ type: 'set-payload', label: 'Set Payload', config: { value: attrs.value || '' } });
      }
    }

    if (k === 'set-variable') {
      for (const el of els) {
        const attrs = (el && el['$']) ? el['$'] : {};
        result.processors.push({ type: 'set-variable', label: `Set Var: ${attrs.variableName || ''}`, config: { name: attrs.variableName, value: attrs.value } });
      }
    }

    // ── Error handling ────────────────────────────────────────────────────────
    if (k === 'catch-exception-strategy' || k === 'on-error-propagate' || k === 'on-error-continue') {
      for (const el of els) {
        const attrs  = (el && el['$']) ? el['$'] : {};
        const when   = attrs.when || attrs.type || null;
        result.errorHandlers.push({ type: 'catch', condition: when });
        result.processors.push({ type: key, label: `Error Handler${when ? ': ' + when : ''}` });
      }
    }

    if (k === 'choice-exception-strategy') {
      for (const el of els) {
        const innerKeys = Object.keys(el).filter(ek => ek !== '$');
        const catches   = innerKeys.filter(ek => ek.toLowerCase().includes('catch')).length;
        result.errorHandlers.push({ type: 'choice', branches: catches });
        result.processors.push({ type: key, label: `Choice Error Handler (${catches} branches)` });
      }
    }

    // ── APIKit router detection ───────────────────────────────────────────────
    if (k === 'apikit:router' || k === 'router') {
      for (const el of els) {
        const attrs = (el && el['$']) ? el['$'] : {};
        result.flowControlSteps.push({ type: 'APIKit', configRef: attrs['config-ref'] || '' });
        result.processors.push({ type: 'apikit:router', label: 'APIKit Router → Multiple iFlows' });
        result.conversionNotes.push({
          type: 'MULTI_FLOW_SPLIT', element: 'apikit:router', severity: 'info',
          suggestion: 'APIKit router splits into one iFlow per HTTP operation (GET/POST/PUT/DELETE per resource). Review generated iFlows.'
        });
      }
    }

    // ── Logger ────────────────────────────────────────────────────────────────
    if (k === 'logger') {
      for (const el of els) {
        const attrs = (el && el['$']) ? el['$'] : {};
        result.processors.push({ type: 'logger', label: `Log: ${(attrs.message || '').substring(0, 60)}` });
      }
    }

    // ── Recurse into sub-elements ─────────────────────────────────────────────
    for (const el of els) {
      if (el && typeof el === 'object' && !['$', '_'].includes(el)) {
        walkFlowElement(el, result, artifact);
      }
    }
  }
}

// ── Extract DataWeave script from transform element ──────────────────────────
function extractDataWeaveScript(el) {
  if (!el || typeof el !== 'object') return null;

  const body      = extractCdata(el['set-payload'] || el['output'] || el['body']);
  const variables = {};

  // <dw:set-variable variableName="x">...</dw:set-variable>
  const setVarEls = el['set-variable'] || [];
  for (const sv of (Array.isArray(setVarEls) ? setVarEls : [setVarEls])) {
    if (!sv) continue;
    const attrs = sv['$'] || {};
    const name  = attrs.variableName || attrs['variableName'] || 'var';
    const val   = extractCdata([sv]);
    if (val) variables[name] = val;
  }

  // <dw:set-property propertyName="x">...</dw:set-property>
  const headers = {};
  const setHdrEls = el['set-property'] || [];
  for (const sh of (Array.isArray(setHdrEls) ? setHdrEls : [setHdrEls])) {
    if (!sh) continue;
    const attrs = sh['$'] || {};
    const name  = attrs.propertyName || 'header';
    const val   = extractCdata([sh]);
    if (val) headers[name] = val;
  }

  if (!body && Object.keys(variables).length === 0) return null;

  return {
    body:      body || '',
    variables,
    headers,
    isDw1:     (body || '').includes('%dw 1.0'),
    outputType: extractOutputType(body || '')
  };
}

function extractCdata(els) {
  if (!els) return null;
  const arr = Array.isArray(els) ? els : [els];
  for (const el of arr) {
    if (typeof el === 'string' && el.trim()) return el.trim();
    if (el && el['_']) return el['_'].trim();
    if (el && typeof el === 'object') {
      // xml2js puts CDATA in '_'
      const keys = Object.keys(el).filter(k => k !== '$');
      if (keys.length === 0 && el['_']) return el['_'].trim();
    }
  }
  return null;
}

function extractOutputType(dwScript) {
  const m = dwScript.match(/%output\s+application\/(\w+)/i) ||
            dwScript.match(/output\s+application\/(\w+)/i);
  return m ? m[1].toLowerCase() : 'json';
}

function assessDwComplexity(script) {
  if (!script) return 'simple';
  const lineCount    = script.split('\n').length;
  const hasMap       = /\bmap\b/.test(script);
  const hasFilter    = /\bfilter\b/.test(script);
  const hasReduce    = /\breduce\b/.test(script);
  const hasGroupBy   = /\bgroupBy\b/.test(script);
  const hasCustomFn  = /\bfun\s+\w+/.test(script);
  const hasFlatten   = /\bflatten\b/.test(script);
  const score = (lineCount > 30 ? 2 : lineCount > 10 ? 1 : 0) +
                (hasMap ? 1 : 0) + (hasFilter ? 1 : 0) + (hasReduce ? 2 : 0) +
                (hasGroupBy ? 2 : 0) + (hasCustomFn ? 2 : 0) + (hasFlatten ? 1 : 0);
  return score >= 5 ? 'complex' : score >= 2 ? 'medium' : 'simple';
}

// ── Extract choice conditions ─────────────────────────────────────────────────
function extractChoiceConditions(el) {
  if (!el || typeof el !== 'object') return [];
  const whens = el['when'] || [];
  return (Array.isArray(whens) ? whens : [whens]).map(w => {
    const attrs = (w && w['$']) ? w['$'] : {};
    return { expression: attrs.expression || '', groovy: melToGroovy(attrs.expression || '') };
  });
}

// ── Minimal MEL → Groovy translation ─────────────────────────────────────────
function melToGroovy(mel) {
  if (!mel) return '';
  return mel
    .replace(/^#\[/, '').replace(/\]$/, '')
    .replace(/flowVars\./g, "message.getProperty('").replace(/(\w+)(?=\s*[=!<>])/g, (m, p1) => {
      if (p1.includes('flowVars')) return p1 + "')";
      return p1;
    })
    .replace(/payload\./g, 'body.')
    .replace(/message\.inboundProperties\[['"]([^'"]+)['"]\]/g, "message.getHeader('$1')")
    .replace(/exception\.causedBy\(([^)]+)\)/g, "exception.class.simpleName == '$1'")
    || mel;
}

// ── Build iflowAdapters list for engine/iflow.js ─────────────────────────────
function deriveAdapterList(result, artifact) {
  // Sender adapter
  const sender = result.senderConfig;
  if (sender) {
    result.iflowAdapters.push(senderAdapterName(sender.type));
  } else {
    result.iflowAdapters.push(senderAdapterName(artifact.trigger_type || 'API'));
  }

  // Receiver adapters (unique)
  const seen = new Set();
  for (const rc of result.receiverConfigs) {
    const name = receiverAdapterName(rc.type);
    if (!seen.has(name)) { result.iflowAdapters.push(name); seen.add(name); }
  }
  // Ensure connectorTypes aligns
  result.connectorTypes = [...new Set(result.connectorTypes)];
}

function senderAdapterName(type) {
  const map = { HTTP: 'HTTP Sender Adapter', API: 'HTTP Sender Adapter', Timer: 'Timer Start Event', Schedule: 'Timer Start Event', JMS: 'JMS Sender Adapter', Event: 'JMS Sender Adapter', Listener: 'SFTP Sender Adapter', SFTP: 'SFTP Sender Adapter' };
  return map[type] || 'HTTP Sender Adapter';
}

function receiverAdapterName(type) {
  const map = { HTTP: 'HTTP Receiver Adapter', JDBC: 'JDBC Receiver Adapter', JMS: 'JMS Receiver Adapter', SFTP: 'SFTP Receiver Adapter', Salesforce: 'Salesforce Receiver Adapter', SAP: 'IDoc/RFC Receiver Adapter', IDoc: 'IDoc Receiver Adapter', RFC: 'RFC Receiver Adapter', Mail: 'Mail Receiver Adapter', SMTP: 'Mail Receiver Adapter', SOAP: 'SOAP Receiver Adapter', MongoDB: '⚠ No Native Adapter (MongoDB)', Workday: 'HTTPS Receiver Adapter (Workday)', ServiceNow: 'HTTPS Receiver Adapter (ServiceNow)' };
  return map[type] || 'HTTP Receiver Adapter';
}

// ── Completeness calculation ─────────────────────────────────────────────────
function calculateCompleteness(result) {
  const total    = result.processors.length;
  if (total === 0) { result.completenessScore = 100; return; }

  const unmapped = result.conversionNotes.filter(n => n.type === 'UNMAPPED_CONNECTOR').length;
  const complex  = result.scripts.filter(s => s.complexity === 'complex').length;

  const deductions = (unmapped * 15) + (complex * 10);
  result.completenessScore = Math.max(0, Math.min(100, 100 - deductions));
}

// ── Fallback when raw_xml not available ──────────────────────────────────────
function buildFallbackPlatformData(artifact) {
  const meta   = artifact.raw_metadata || {};
  const conns  = Array.isArray(meta.connectorTypes) ? meta.connectorTypes : [];
  return {
    processors:        [{ type: 'http:listener', label: 'HTTP Trigger (from metadata)' }],
    connectorTypes:    conns,
    iflowAdapters:     [senderAdapterName(artifact.trigger_type || 'API'), ...conns.map(c => receiverAdapterName(c))],
    dataWeaveTransforms: [],
    scripts:           [],
    flowControlSteps:  [],
    errorHandlers:     [],
    senderConfig:      null,
    receiverConfigs:   [],
    conversionNotes:   [{ type: 'NO_RAW_XML', severity: 'info', suggestion: 'Re-upload source file to enable real connector extraction' }],
    completenessScore: 60,
    _source:           'metadata_fallback'
  };
}

// ── Build Groovy script content from DataWeave script ─────────────────────────
function buildGroovyFromDataWeave(artifact, dwScript, index) {
  const name     = `${artifact.name.replace(/[^a-zA-Z0-9]/g, '_')}_Transform_${index + 1}`;
  const varLines = Object.entries(dwScript.variables || {}).map(([k, v]) =>
    `    // Variable "${k}":\n    // ${v.replace(/\n/g, '\n    // ')}`
  ).join('\n\n');
  const hdrLines = Object.entries(dwScript.headers || {}).map(([k, v]) =>
    `    // Header "${k}":\n    // ${v.replace(/\n/g, '\n    // ')}`
  ).join('\n\n');

  return {
    filename: `${name}.groovy`,
    content: `/**
 * ${name}
 * Migrated from MuleSoft DataWeave ${dwScript.isDw1 ? '1.0' : '2.0'}
 * Output type: ${dwScript.outputType}
 * Complexity: ${dwScript.complexity || 'unknown'}
 *
 * ORIGINAL DATAWEAVE SCRIPT (preserved for reference):
 * ════════════════════════════════════════════════════
${(dwScript.body || '').split('\n').map(l => ' * ' + l).join('\n')}
 * ════════════════════════════════════════════════════
${varLines ? ' *\n * SIDE OUTPUTS (variables):\n' + varLines : ''}
${hdrLines ? ' *\n * HEADER OUTPUTS:\n' + hdrLines : ''}
 *
 * TODO: Implement equivalent logic below in Groovy for SAP IS
 */

import com.sap.gateway.ip.core.customdev.util.Message
import groovy.json.JsonSlurper
import groovy.json.JsonOutput
import groovy.xml.MarkupBuilder

def Message processData(Message message) {
    def body = message.getBody(java.lang.String.class)

    // Detect and parse input format
    def parsed = null
    try {
        parsed = new JsonSlurper().parseText(body)
    } catch (e) {
        // Input may be XML — use: new XmlSlurper().parseText(body)
    }

    //
    // TODO: Translate DataWeave logic to Groovy
    // DataWeave output type was: ${dwScript.outputType}
    //
    // Common patterns:
    //   DW: payload map { field: $.sourceField }
    //   Groovy: def result = parsed.collect { [field: it.sourceField] }
    //
    //   DW: payload filter $.active == true
    //   Groovy: def result = parsed.findAll { it.active == true }
    //
    //   DW: payload.firstName ++ " " ++ payload.lastName
    //   Groovy: "\${parsed.firstName} \${parsed.lastName}"
    //

    def result = parsed // REPLACE with actual transformation

    // Set output
    ${dwScript.outputType === 'json' ? 'message.setBody(JsonOutput.toJson(result))' :
      dwScript.outputType === 'xml'  ? '// Use MarkupBuilder to build XML output\nmessage.setBody(result.toString())' :
      'message.setBody(result.toString())'}

    return message
}
`
  };
}

module.exports = {
  extractMuleSoftPlatformData,
  buildGroovyFromDataWeave
};
