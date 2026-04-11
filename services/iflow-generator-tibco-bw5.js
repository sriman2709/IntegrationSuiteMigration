/**
 * iFlow Generator — TIBCO BW5 Platform Data Extractor (S8)
 *
 * Parses TIBCO BW5 ProcessDef raw_xml to extract:
 *  - Activity sequence (ordered from pd:transition graph)
 *  - XSLT / XPath mapper content (embedded in mapper activities)
 *  - Java code (from JavaCode activities → Groovy stubs)
 *  - Sender config from pd:starter type
 *  - Receiver configs from activity xsi:type (JDBC, HTTP, JMS, SFTP, SMTP, SAP)
 *  - Error handlers from pd:group catch blocks
 *
 * BW5 XML key facts:
 *  - Root element: <pd:ProcessDef> — after stripPrefix becomes 'ProcessDef' or 'processdef'
 *  - Starter: <pd:starter> with xsi:type like "bw.http.HTTPEventSourceConfig"
 *  - Activities: <pd:activity> with xsi:type like "bw.jdbc.JDBCQuery"
 *  - Transitions: <pd:transition> with <pd:from> and <pd:to>
 *  - Groups: <pd:group> for catch scopes
 *  - Mapper activity stores XSLT/XPath in inputBindings or as inline expressions
 */

'use strict';

const xml2js = require('xml2js');

// ── Parse BW5 raw_xml and extract full platform data ──────────────────────────
async function extractBw5PlatformData(artifact) {
  const result = {
    _source: 'raw_xml_bw5',
    platform: 'tibco-bw5',
    artifactName: artifact.name,
    triggerType: artifact.trigger_type || 'API',
    processors: [],
    xsltTransforms: [],
    javaScripts: [],
    errorHandlers: [],
    connectorTypes: [],
    senderConfig: null,
    receiverConfigs: [],
    hasXslt: false,
    hasJava: false,
    hasFaultHandlers: false,
    completenessScore: 80,
    notes: []
  };

  if (!artifact.raw_xml) {
    result.notes.push({ level: 'warn', msg: 'No raw_xml — using metadata fallback' });
    return buildBw5FallbackData(artifact, result);
  }

  try {
    const parser = new xml2js.Parser({
      explicitArray: true,
      ignoreAttrs: false,
      tagNameProcessors: [xml2js.processors.stripPrefix]
    });
    const parsed = await parser.parseStringPromise(artifact.raw_xml);

    const root = findProcessDefRoot(parsed);
    if (!root) {
      result.notes.push({ level: 'warn', msg: 'Could not find ProcessDef root element' });
      return buildBw5FallbackData(artifact, result);
    }

    // Extract starter (trigger)
    const senderCfg = extractBw5SenderConfig(root, artifact);
    result.senderConfig  = senderCfg;
    result.triggerType   = senderCfg ? senderCfg.triggerType : (artifact.trigger_type || 'API');

    // Extract all activities in transition order
    const activities = extractBw5Activities(root);
    const transitions = extractBw5Transitions(root);
    const ordered = orderActivities(activities, transitions);

    // Build processor list
    for (const act of ordered) {
      const proc = buildBw5Processor(act, artifact, result);
      if (proc) result.processors.push(proc);
    }

    // Extract XSLT/Java from mapper and JavaCode activities
    const xsltFiles = extractBw5XsltTransforms(root, artifact);
    const javaFiles = extractBw5JavaScripts(root, artifact);
    result.xsltTransforms = xsltFiles;
    result.javaScripts    = javaFiles;
    result.hasXslt  = xsltFiles.length > 0;
    result.hasJava  = javaFiles.length > 0;

    // Extract error handlers from group/catch
    const faults = extractBw5FaultHandlers(root, artifact);
    result.errorHandlers    = faults;
    result.hasFaultHandlers = faults.length > 0;

    // Receiver configs
    const receiverCfgs = extractBw5ReceiverConfigs(root, artifact);
    result.receiverConfigs = receiverCfgs;

    // Connector types
    const connSet = new Set(receiverCfgs.map(r => r.type).filter(Boolean));
    if (senderCfg && senderCfg.type) connSet.add(senderCfg.type);
    result.connectorTypes = [...connSet];
    if (result.connectorTypes.length === 0) result.connectorTypes = ['HTTP'];

    result.completenessScore = calculateBw5Completeness(result);

  } catch (err) {
    result.notes.push({ level: 'error', msg: `Parse error: ${err.message}` });
    return buildBw5FallbackData(artifact, result);
  }

  return result;
}

// ── Find ProcessDef root ──────────────────────────────────────────────────────
function findProcessDefRoot(parsed) {
  const candidates = ['ProcessDef', 'processdef', 'process', 'Process', 'BusinessWorksProject'];
  for (const c of candidates) {
    if (parsed[c]) {
      const val = parsed[c];
      return Array.isArray(val) ? val[0] : val;
    }
  }
  // Try any root key
  for (const key of Object.keys(parsed)) {
    const val = parsed[key];
    const obj = Array.isArray(val) ? val[0] : val;
    if (obj && (obj['starter'] || obj['activity'] || obj['transition'] || obj['group'])) return obj;
  }
  return null;
}

// ── Extract starter (trigger) config ─────────────────────────────────────────
function extractBw5SenderConfig(root, artifact) {
  const starterKeys = ['starter', 'Starter', 'pd:starter'];
  for (const key of starterKeys) {
    if (!root[key]) continue;
    const starters = Array.isArray(root[key]) ? root[key] : [root[key]];
    const s = starters[0];
    if (!s) continue;
    const attrs = s['$'] || {};
    const type  = (attrs.type || attrs['xsi:type'] || '').toLowerCase();
    const name  = attrs.name || 'Starter';

    if (/timer|schedule|cron/i.test(type)) {
      const schedEl  = findFirst(s, ['config', 'timerConfig', 'scheduleConfig']);
      const interval = schedEl ? (schedEl['$'] || {}).interval || '60' : '60';
      return { type: 'Schedule', triggerType: 'Schedule', name, interval, cronExpr: '0 0/1 * * * ?' };
    }
    if (/jms|ems|queue|topic/i.test(type)) {
      const dest = findFirst(s, ['destination', 'queueName', 'topicName']);
      const queue = dest ? textOf(dest) : '{{param.jms.queue}}';
      return { type: 'JMS', triggerType: 'Event', name, queue };
    }
    if (/file|sftp|ftp/i.test(type)) {
      const dir = findFirst(s, ['directoryName', 'directory', 'path']);
      return { type: 'SFTP', triggerType: 'Listener', name, directory: dir ? textOf(dir) : '/inbound' };
    }
    if (/soap|wsdl/i.test(type)) {
      const wsdl = findFirst(s, ['wsdl', 'wsdlFile']);
      return { type: 'SOAP', triggerType: 'API', name, wsdl: wsdl ? textOf(wsdl) : '' };
    }
    // Default HTTP
    const pathEl   = findFirst(s, ['path', 'servicePath', 'urlPath']);
    const methodEl = findFirst(s, ['method', 'httpMethod']);
    const path   = pathEl   ? textOf(pathEl)   : `/${artifact.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    const method = methodEl ? textOf(methodEl) : 'POST';
    return { type: 'HTTP', triggerType: 'API', name, path, method };
  }
  // No starter found — default HTTP
  return { type: 'HTTP', triggerType: artifact.trigger_type || 'API',
           path: `/${artifact.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`, method: 'POST' };
}

// ── Extract activity elements ─────────────────────────────────────────────────
function extractBw5Activities(root) {
  const activities = [];
  const activityKeys = ['activity', 'Activity'];

  for (const key of activityKeys) {
    if (!root[key]) continue;
    const acts = Array.isArray(root[key]) ? root[key] : [root[key]];
    for (const act of acts) {
      const attrs = act['$'] || {};
      activities.push({
        name:    attrs.name || `Activity_${activities.length + 1}`,
        type:    (attrs.type || attrs['xsi:type'] || 'unknown').toLowerCase(),
        rawType: attrs.type || attrs['xsi:type'] || '',
        raw:     act
      });
    }
  }

  // Also look in groups (error handler scopes)
  const groupKeys = ['group', 'Group'];
  for (const key of groupKeys) {
    if (!root[key]) continue;
    const groups = Array.isArray(root[key]) ? root[key] : [root[key]];
    for (const g of groups) {
      for (const actKey of activityKeys) {
        if (!g[actKey]) continue;
        const acts = Array.isArray(g[actKey]) ? g[actKey] : [g[actKey]];
        for (const act of acts) {
          const attrs = act['$'] || {};
          activities.push({
            name:    attrs.name || `GroupActivity_${activities.length + 1}`,
            type:    (attrs.type || attrs['xsi:type'] || 'unknown').toLowerCase(),
            rawType: attrs.type || attrs['xsi:type'] || '',
            raw:     act,
            inGroup: true
          });
        }
      }
    }
  }

  return activities;
}

// ── Extract transitions (flow links) ─────────────────────────────────────────
function extractBw5Transitions(root) {
  const edges = []; // { from, to }
  const transKeys = ['transition', 'Transition'];
  for (const key of transKeys) {
    if (!root[key]) continue;
    const trans = Array.isArray(root[key]) ? root[key] : [root[key]];
    for (const t of trans) {
      const from = textOf(t['from'] || t['From']) || (t['$'] || {}).from;
      const to   = textOf(t['to']   || t['To'])   || (t['$'] || {}).to;
      if (from && to) edges.push({ from, to });
    }
  }
  return edges;
}

// ── Order activities by transition graph (Kahn's topo-sort) ──────────────────
function orderActivities(activities, edges) {
  if (edges.length === 0 || activities.length === 0) return activities;

  const nameMap = {};
  activities.forEach(a => { nameMap[a.name] = a; });

  const inDegree = {};
  const adj = {};
  activities.forEach(a => { inDegree[a.name] = 0; adj[a.name] = []; });

  for (const e of edges) {
    if (adj[e.from] !== undefined && inDegree[e.to] !== undefined) {
      adj[e.from].push(e.to);
      inDegree[e.to]++;
    }
  }

  const queue  = activities.filter(a => inDegree[a.name] === 0).map(a => a.name);
  const result = [];

  while (queue.length > 0) {
    const n = queue.shift();
    if (nameMap[n]) result.push(nameMap[n]);
    for (const nbr of (adj[n] || [])) {
      inDegree[nbr]--;
      if (inDegree[nbr] === 0) queue.push(nbr);
    }
  }

  // Add any disconnected
  activities.forEach(a => { if (!result.includes(a)) result.push(a); });
  return result;
}

// ── Build a processor step from a BW5 activity ───────────────────────────────
function buildBw5Processor(act, artifact, result) {
  const type = act.type;
  const name = act.name;

  // Skip error-handler-only activities (inGroup without outbound connector)
  // But still emit them as note steps so the iFlow is complete

  // JDBC
  if (/jdbc|sql|database|db/i.test(type)) {
    const sql = extractSqlFromActivity(act.raw);
    result.connectorTypes.push('JDBC');
    return { type: 'invoke', label: name, config: { connType: 'JDBC', sql } };
  }

  // HTTP outbound
  if (/http\.sendhttp|http\.call|http\.httprequest|soap/i.test(type)) {
    result.connectorTypes.push('HTTP');
    return { type: 'invoke', label: name, config: { connType: 'HTTP' } };
  }

  // JMS publisher
  if (/jms|ems|rv\.publish/i.test(type)) {
    result.connectorTypes.push('JMS');
    return { type: 'invoke', label: name, config: { connType: 'JMS' } };
  }

  // SFTP / FTP / File write
  if (/sftp|ftp|file\.write|filewrite/i.test(type)) {
    result.connectorTypes.push('SFTP');
    return { type: 'invoke', label: name, config: { connType: 'SFTP' } };
  }

  // SMTP / Mail
  if (/smtp|mail|email/i.test(type)) {
    result.connectorTypes.push('SMTP');
    return { type: 'invoke', label: name, config: { connType: 'SMTP' } };
  }

  // SAP / BAPI / RFC
  if (/sap|bapi|rfc/i.test(type)) {
    result.connectorTypes.push('SAP');
    const fn = extractAttr(act.raw, 'functionName') || extractAttr(act.raw, 'rfcName') || '{{param.sap.function}}';
    return { type: 'invoke', label: name, config: { connType: 'SAP', function: fn } };
  }

  // Mapper / Transform / XSLT
  if (/mapper|transform|xslt|map/i.test(type)) {
    const xslt = extractXsltFromActivity(act.raw);
    if (xslt) {
      const safeName = `${artifact.name.replace(/[^a-zA-Z0-9]/g, '_')}_${name.replace(/[^a-zA-Z0-9]/g, '_')}.xsl`;
      return { type: 'xslt', label: name, config: { xslFile: safeName, xsltContent: xslt } };
    }
    return { type: 'contentModifier', label: name, config: { note: 'BW5 mapper — review XPath mappings' } };
  }

  // Java / Script / Groovy
  if (/java|script|groovy|javascript/i.test(type)) {
    const javaCode = extractJavaFromActivity(act.raw);
    const safeName = `${artifact.name.replace(/[^a-zA-Z0-9]/g, '_')}_${name.replace(/[^a-zA-Z0-9]/g, '_')}.groovy`;
    return { type: 'javaScript', label: name, config: { scriptFile: safeName, javaCode } };
  }

  // SubProcess call
  if (/subprocess|callprocess|callingprocess/i.test(type)) {
    const target = extractAttr(act.raw, 'processName') || extractAttr(act.raw, 'process') || 'SubProcess';
    return { type: 'processCall', label: name, config: { processName: target } };
  }

  // Log
  if (/log|logger|trace/i.test(type)) {
    return { type: 'log', label: name, config: {} };
  }

  // Timer / Wait
  if (/timer|wait|sleep/i.test(type)) {
    return { type: 'contentModifier', label: name, config: { note: 'BW5 timer/wait activity' } };
  }

  // Generic / unknown
  return { type: 'contentModifier', label: name, config: { note: `BW5 activity: ${act.rawType || type}` } };
}

// ── Extract XSLT transforms for ZIP emission ──────────────────────────────────
function extractBw5XsltTransforms(root, artifact) {
  const xslts  = [];
  const actKeys = ['activity', 'Activity'];

  for (const key of actKeys) {
    if (!root[key]) continue;
    const acts = Array.isArray(root[key]) ? root[key] : [root[key]];
    for (const act of acts) {
      const attrs = act['$'] || {};
      const type  = (attrs.type || attrs['xsi:type'] || '').toLowerCase();
      const name  = (attrs.name || 'Transform').replace(/[^a-zA-Z0-9]/g, '_');

      if (!/mapper|transform|xslt|map/i.test(type)) continue;

      const xslt = extractXsltFromActivity(act);
      if (!xslt) continue;

      const safeArt = artifact.name.replace(/[^a-zA-Z0-9]/g, '_');
      xslts.push({
        filename:     `${safeArt}_${name}.xsl`,
        content:      xslt,
        activityName: name
      });
    }
  }
  return xslts;
}

// ── Extract Java code scripts for ZIP emission (as Groovy stubs) ─────────────
function extractBw5JavaScripts(root, artifact) {
  const scripts = [];
  const actKeys = ['activity', 'Activity'];

  for (const key of actKeys) {
    if (!root[key]) continue;
    const acts = Array.isArray(root[key]) ? root[key] : [root[key]];
    for (const act of acts) {
      const attrs = act['$'] || {};
      const type  = (attrs.type || attrs['xsi:type'] || '').toLowerCase();
      const name  = (attrs.name || 'Script').replace(/[^a-zA-Z0-9]/g, '_');

      if (!/java|script|groovy|javascript/i.test(type)) continue;

      const javaCode = extractJavaFromActivity(act);
      const safeArt  = artifact.name.replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `${safeArt}_${name}.groovy`;

      scripts.push({
        filename,
        activityName: name,
        content: buildGroovyStub(name, javaCode, attrs.type || '')
      });
    }
  }
  return scripts;
}

// ── Build Groovy stub preserving original Java code as comment ─────────────
function buildGroovyStub(name, javaCode, originalType) {
  const codeBlock = javaCode
    ? javaCode.split('\n').map(l => `// ${l}`).join('\n')
    : '// (no Java source found in activity)';

  return `import com.sap.gateway.ip.core.customdev.util.Message
import groovy.json.JsonSlurper
import groovy.json.JsonOutput

// ═══════════════════════════════════════════════════════════════════════════
// Migrated from TIBCO BW5 JavaCode activity: ${name}
// Original type: ${originalType}
// ─────────────────────────────────────────────────────────────────────────
// Original Java source (preserved — implement equivalent logic below):
//
${codeBlock}
//
// ═══════════════════════════════════════════════════════════════════════════
// TODO: Implement equivalent logic in Groovy below.
// SAP IS Groovy context: 'message' is the com.sap.gateway.ip.core.customdev.util.Message object
// ═══════════════════════════════════════════════════════════════════════════

def Message processData(Message message) {
    def body    = message.getBody(String.class)
    def headers = message.getHeaders()

    // TODO: Add your implementation here

    message.setBody(body)
    return message
}
`;
}

// ── Extract fault handlers (pd:group with catch) ──────────────────────────────
function extractBw5FaultHandlers(root, artifact) {
  const handlers  = [];
  const groupKeys = ['group', 'Group'];

  for (const key of groupKeys) {
    if (!root[key]) continue;
    const groups = Array.isArray(root[key]) ? root[key] : [root[key]];
    for (const g of groups) {
      const attrs = g['$'] || {};
      const name  = attrs.name || 'CatchGroup';
      // BW5 groups with catch type indicate error handler
      if (/catch|fault|error|exception/i.test(name) || attrs.type === 'catch') {
        handlers.push({ type: 'catch', faultName: name });
      } else {
        handlers.push({ type: 'catch', faultName: name });
      }
    }
  }
  return handlers;
}

// ── Extract receiver (invoke) configs ─────────────────────────────────────────
function extractBw5ReceiverConfigs(root, artifact) {
  const configs  = [];
  const seen     = new Set();
  const actKeys  = ['activity', 'Activity'];

  for (const key of actKeys) {
    if (!root[key]) continue;
    const acts = Array.isArray(root[key]) ? root[key] : [root[key]];
    for (const act of acts) {
      const attrs = act['$'] || {};
      const type  = (attrs.type || attrs['xsi:type'] || '').toLowerCase();

      let connType = null;
      if (/jdbc|sql|database|db/i.test(type))           connType = 'JDBC';
      else if (/http\.send|http\.call|soap/i.test(type)) connType = 'HTTP';
      else if (/jms|ems/i.test(type))                   connType = 'JMS';
      else if (/sftp|ftp|file\.write/i.test(type))      connType = 'SFTP';
      else if (/smtp|mail/i.test(type))                  connType = 'SMTP';
      else if (/sap|bapi|rfc/i.test(type))              connType = 'SAP';

      if (connType && !seen.has(connType)) {
        seen.add(connType);
        const cfg = { type: connType };
        if (connType === 'JDBC') cfg.sql  = extractSqlFromActivity(act);
        if (connType === 'SAP')  cfg.function = extractAttr(act, 'functionName') || '{{param.sap.function}}';
        configs.push(cfg);
      }
    }
  }

  if (configs.length === 0) configs.push({ type: 'HTTP', url: '{{param.receiver.http.address}}' });
  return configs;
}

// ── Completeness scoring ───────────────────────────────────────────────────────
function calculateBw5Completeness(result) {
  let score = 100;
  const unmapped = result.connectorTypes.filter(t => /mongo|kafka|s3|aws/i.test(t)).length;
  score -= unmapped * 15;
  if (result.hasJava) score -= 10; // Java stubs need dev review
  if (result.hasXslt) score = Math.min(100, score + 5);
  return Math.max(30, score);
}

// ── Fallback when no raw_xml ───────────────────────────────────────────────────
function buildBw5FallbackData(artifact, base) {
  const connTypes = (artifact.connector_types || '').split(',').filter(Boolean);
  return {
    ...base,
    _source: 'metadata_fallback',
    connectorTypes: connTypes.length > 0 ? connTypes : ['HTTP'],
    triggerType:    artifact.trigger_type || 'API',
    senderConfig:   { type: 'HTTP', triggerType: artifact.trigger_type || 'API',
                      path: `/${artifact.name}`, method: 'POST' },
    receiverConfigs: connTypes.map(t => ({ type: t })),
    processors:     [],
    completenessScore: 50
  };
}

// ── XML helper: extract XSLT from a mapper activity node ─────────────────────
function extractXsltFromActivity(node) {
  if (!node || typeof node !== 'object') return null;

  // Look for inputBindings with XSLT content
  const bindingKeys = ['inputBindings', 'InputBindings', 'inputbindings', 'binding'];
  for (const k of bindingKeys) {
    if (!node[k]) continue;
    const bindings = Array.isArray(node[k]) ? node[k] : [node[k]];
    for (const b of bindings) {
      const text = typeof b === 'string' ? b : (b['_'] || JSON.stringify(b));
      if (text && (text.includes('<xsl:') || text.includes('&lt;xsl:'))) {
        return text.includes('&lt;') ? htmlUnescape(text) : text;
      }
    }
  }

  // Look for xsl attribute or text content anywhere in node
  const str = JSON.stringify(node);
  const xslMatch = str.match(/<xsl:stylesheet[^]*?<\/xsl:stylesheet>/);
  if (xslMatch) return xslMatch[0];

  // Look for escaped XSLT
  if (str.includes('&lt;xsl:stylesheet')) {
    const escaped = str.match(/&lt;xsl:stylesheet[^]*?&lt;\/xsl:stylesheet&gt;/);
    if (escaped) return htmlUnescape(escaped[0]);
  }

  return null;
}

// ── XML helper: extract Java code from JavaCode activity ─────────────────────
function extractJavaFromActivity(node) {
  if (!node || typeof node !== 'object') return null;

  const codeKeys = ['code', 'Code', 'javaCode', 'JavaCode', 'source', 'script'];
  for (const k of codeKeys) {
    if (!node[k]) continue;
    const els = Array.isArray(node[k]) ? node[k] : [node[k]];
    for (const el of els) {
      const text = typeof el === 'string' ? el : (el['_'] || '');
      if (text && text.trim().length > 0) return text.trim();
    }
  }
  return null;
}

// ── XML helper: extract SQL from JDBC activity ────────────────────────────────
function extractSqlFromActivity(node) {
  if (!node || typeof node !== 'object') return null;
  const sqlKeys = ['statement', 'query', 'sql', 'Query', 'Statement', 'SQL'];
  for (const k of sqlKeys) {
    if (!node[k]) continue;
    const els = Array.isArray(node[k]) ? node[k] : [node[k]];
    const text = typeof els[0] === 'string' ? els[0] : (els[0] && els[0]['_']) || '';
    if (text) return text.trim().substring(0, 500);
  }
  return null;
}

// ── XML helper: find first element by key name ────────────────────────────────
function findFirst(node, keys) {
  if (!node || typeof node !== 'object') return null;
  for (const k of keys) {
    if (!node[k]) continue;
    const val = Array.isArray(node[k]) ? node[k][0] : node[k];
    if (val) return val;
  }
  return null;
}

// ── XML helper: extract text content ─────────────────────────────────────────
function textOf(el) {
  if (!el) return null;
  if (typeof el === 'string') return el.trim() || null;
  if (Array.isArray(el)) return textOf(el[0]);
  if (el['_']) return el['_'].trim() || null;
  return null;
}

// ── XML helper: extract attribute from node ───────────────────────────────────
function extractAttr(node, attrName) {
  if (!node || typeof node !== 'object') return null;
  const attrs = node['$'] || {};
  return attrs[attrName] || null;
}

// ── HTML entity unescape ──────────────────────────────────────────────────────
function htmlUnescape(str) {
  if (!str) return '';
  return str
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&amp;/g,  '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

module.exports = { extractBw5PlatformData };
