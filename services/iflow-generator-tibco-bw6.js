/**
 * iFlow Generator — TIBCO BW6 Platform Data Extractor (S7)
 *
 * Parses TIBCO BW6 .bwp (BPWS/BPEL 2.0) raw_xml to extract:
 *  - Activity sequence (topological sort of link/transition graph)
 *  - XSLT 1.0 transforms (HTML-unescaped from tibex:inputBinding expression attributes)
 *  - Invoke/receive connector types with real config
 *  - Fault handlers → exception sub-processes
 *
 * Key fact: TIBCO BW6 embeds XSLT 1.0 as HTML-escaped strings in `expression` attributes.
 * Unescape → valid XSLT 1.0 that SAP IS supports natively in XSLT mapping steps.
 */

'use strict';

const xml2js = require('xml2js');

// ── HTML entity unescape ────────────────────────────────────────────────────────
function htmlUnescape(str) {
  if (!str) return '';
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

// ── Parse BW6 raw_xml and extract full platform data ───────────────────────────
async function extractBw6PlatformData(artifact) {
  const result = {
    _source: 'raw_xml_bw6',
    platform: 'tibco-bw6',
    artifactName: artifact.name,
    triggerType: artifact.trigger_type || 'API',
    processors: [],
    xsltTransforms: [],
    errorHandlers: [],
    connectorTypes: [],
    senderConfig: null,
    receiverConfigs: [],
    hasXslt: false,
    hasFaultHandlers: false,
    completenessScore: 80,
    notes: []
  };

  if (!artifact.raw_xml) {
    result.notes.push({ level: 'warn', msg: 'No raw_xml — using metadata fallback' });
    return buildBw6FallbackData(artifact, result);
  }

  try {
    const parser = new xml2js.Parser({
      explicitArray: true,
      ignoreAttrs: false,
      tagNameProcessors: [xml2js.processors.stripPrefix]
    });
    const parsed = await parser.parseStringPromise(artifact.raw_xml);

    // BW6 root: <process> inside namespace (bpws: or ns1: etc)
    const root = findRoot(parsed);
    if (!root) {
      result.notes.push({ level: 'warn', msg: 'Could not find process root element' });
      return buildBw6FallbackData(artifact, result);
    }

    // Extract activities in execution order
    const activities = extractActivities(root);
    const linkGraph  = extractLinkGraph(root, activities);
    const ordered    = topoSort(activities, linkGraph);

    // Build processor list from ordered activities
    for (const act of ordered) {
      const proc = buildProcessor(act, artifact);
      if (proc) result.processors.push(proc);
    }

    // Extract XSLT transforms from all assign/mapper nodes
    const xsltFiles = extractXsltTransforms(root, artifact);
    result.xsltTransforms = xsltFiles;
    result.hasXslt = xsltFiles.length > 0;

    // Extract fault handlers
    const faults = extractFaultHandlers(root, artifact);
    result.errorHandlers = faults;
    result.hasFaultHandlers = faults.length > 0;

    // Sender/receiver config from receive/invoke elements
    const senderCfg   = extractSenderConfig(root, artifact);
    const receiverCfgs = extractReceiverConfigs(root, artifact);
    result.senderConfig   = senderCfg;
    result.receiverConfigs = receiverCfgs;
    result.triggerType = senderCfg ? senderCfg.triggerType : (artifact.trigger_type || 'API');

    // Connector types
    const connSet = new Set(receiverCfgs.map(r => r.type).filter(Boolean));
    if (senderCfg && senderCfg.type) connSet.add(senderCfg.type);
    result.connectorTypes = [...connSet];
    if (result.connectorTypes.length === 0) result.connectorTypes = ['HTTP'];

    // Completeness
    result.completenessScore = calculateCompleteness(result);

  } catch (err) {
    result.notes.push({ level: 'error', msg: `Parse error: ${err.message}` });
    return buildBw6FallbackData(artifact, result);
  }

  return result;
}

// ── Find process root regardless of namespace prefix ───────────────────────────
function findRoot(parsed) {
  // Try common root keys
  const candidates = ['process', 'Process', 'definitions', 'Definitions'];
  for (const c of candidates) {
    if (parsed[c]) return parsed[c][0] || parsed[c];
  }
  // Try any key that looks like it contains sequence/flow
  for (const key of Object.keys(parsed)) {
    const val = parsed[key];
    const obj = Array.isArray(val) ? val[0] : val;
    if (obj && (obj['sequence'] || obj['flow'] || obj['receive'] || obj['scope'])) return obj;
  }
  return null;
}

// ── Extract activities from process root ──────────────────────────────────────
// ── Map BW6 activityTypeID → activity role ────────────────────────────────────
// BW6 stores the canonical type in BWActivity[0].$.activityTypeID
// e.g. "bw.generalactivities.log", "bw.file.write", "bw.http.HTTPClientSend"
function bw6ActivityRole(extEl) {
  // Pull activityTypeID from config/BWActivity
  const config  = extEl?.config?.[0];
  const bwAct   = config?.BWActivity?.[0];
  const typeId  = (bwAct?.['$']?.activityTypeID || '').toLowerCase();

  if (!typeId) {
    // Fallback: stringify search for older formats
    const xmlStr = JSON.stringify(extEl);
    if (/bw\.http|httpconnector|httpclient/i.test(xmlStr))   return 'invoke-http';
    if (/bw\.soap|soapsend/i.test(xmlStr))                   return 'invoke-soap';
    if (/bw\.jms|jmssend/i.test(xmlStr))                     return 'invoke-jms';
    if (/bw\.jdbc/i.test(xmlStr))                             return 'invoke-jdbc';
    if (/bw\.file\.write/i.test(xmlStr))                      return 'invoke-file-write';
    if (/bw\.file\.read/i.test(xmlStr))                       return 'invoke-file-read';
    if (/bw\.sftp/i.test(xmlStr))                             return 'invoke-sftp';
    if (/bw\.mail|bw\.smtp/i.test(xmlStr))                    return 'invoke-smtp';
    if (/bw\.sap|bw\.rfc/i.test(xmlStr))                      return 'invoke-sap';
    if (/generalactivities\.log|writetolog/i.test(xmlStr))    return 'log';
    if (/generalactivities\.mapper|xslttransform/i.test(xmlStr)) return 'xslt';
    if (/generalactivities\.generateerror/i.test(xmlStr))     return 'throw';
    if (/internal\.end/i.test(xmlStr))                        return 'end';
    if (/internal\.callprocess|subprocess/i.test(xmlStr))     return 'processCall';
    return 'activity';
  }

  // Canonical mapping via activityTypeID
  if (typeId.includes('bw.internal.end'))              return 'end';
  if (typeId.includes('bw.internal.start'))            return 'trigger';
  if (typeId.includes('bw.internal.callprocess'))      return 'processCall';
  if (typeId.includes('bw.generalactivities.log'))     return 'log';
  if (typeId.includes('bw.generalactivities.mapper') ||
      typeId.includes('bw.xml.xslttransform'))         return 'xslt';
  if (typeId.includes('bw.generalactivities.generate')) return 'throw';
  if (typeId.includes('bw.generalactivities.sleep'))   return 'log'; // timer → treat as step
  if (typeId.includes('bw.http'))                      return 'invoke-http';
  if (typeId.includes('bw.soap'))                      return 'invoke-soap';
  if (typeId.includes('bw.jms') || typeId.includes('bw.ems')) return 'invoke-jms';
  if (typeId.includes('bw.jdbc'))                      return 'invoke-jdbc';
  if (typeId.includes('bw.file.write'))                return 'invoke-file-write';
  if (typeId.includes('bw.file.read'))                 return 'invoke-file-read';
  if (typeId.includes('bw.sftp'))                      return 'invoke-sftp';
  if (typeId.includes('bw.mail') || typeId.includes('bw.smtp')) return 'invoke-smtp';
  if (typeId.includes('bw.sap') || typeId.includes('bw.rfc'))   return 'invoke-sap';
  if (typeId.includes('bw.xml'))                       return 'xslt';
  if (typeId.includes('bw.rest'))                      return 'invoke-http';
  if (typeId.includes('bw.ftp'))                       return 'invoke-sftp';
  if (typeId.includes('bw.tcp'))                       return 'invoke-http';

  return 'activity'; // unrecognised but still counted
}

function extractActivities(root) {
  const activities = [];
  let seq = 0;

  function walk(node, depth) {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node).filter(k => k !== '$')) {
      const els = Array.isArray(node[key]) ? node[key] : [node[key]];
      const k = key.toLowerCase();

      for (const el of els) {
        if (!el || typeof el !== 'object') continue;
        const attrs = el['$'] || {};
        const actName = attrs.name || attrs.Name || `activity_${seq}`;

        // ── BW6 primary pattern: <bpws:extensionActivity> ──────────────────
        if (k === 'extensionactivity') {
          // Find the inner activityExtension or starterExtension
          const extKey = Object.keys(el).find(k2 =>
            /activityextension|starterextension/i.test(k2)
          );
          if (extKey) {
            const extEls = Array.isArray(el[extKey]) ? el[extKey] : [el[extKey]];
            for (const extEl of extEls) {
              const extAttrs = extEl['$'] || {};
              const name = extAttrs.name || extAttrs.Name || actName;
              const role = /starterextension/i.test(extKey) ? 'trigger' : bw6ActivityRole(extEl);
              // Skip pure end events from processor count but keep for flow
              if (role !== 'end') {
                activities.push({ seq: seq++, key: extKey, k: role, name, role, raw: extEl });
              }
            }
          } else {
            // extensionActivity without known child — walk deeper
            walk(el, depth + 1);
          }

        // ── Standard BPEL elements ──────────────────────────────────────────
        } else if (k === 'receive') {
          activities.push({ seq: seq++, key, k, name: actName, role: 'trigger', raw: el });
        } else if (k === 'invoke') {
          activities.push({ seq: seq++, key, k, name: actName, role: 'invoke', raw: el });
        } else if (k === 'assign') {
          activities.push({ seq: seq++, key, k, name: actName, role: 'assign', raw: el });
        } else if (k === 'mapper' || k === 'tns:mapper') {
          activities.push({ seq: seq++, key, k, name: actName, role: 'mapper', raw: el });
        } else if (k === 'reply') {
          activities.push({ seq: seq++, key, k, name: actName, role: 'reply', raw: el });
        } else if (k === 'throw') {
          activities.push({ seq: seq++, key, k, name: actName, role: 'throw', raw: el });
        } else if (k === 'scope') {
          activities.push({ seq: seq++, key, k, name: actName, role: 'scope', raw: el });
          walk(el, depth + 1);
        } else if (k === 'if' || k === 'switch') {
          activities.push({ seq: seq++, key, k, name: actName, role: 'router', raw: el });
        } else if (k === 'foreach' || k === 'while' || k === 'repeatuntil') {
          activities.push({ seq: seq++, key, k, name: actName, role: 'loop', raw: el });
        } else if (k === 'flow' || k === 'sequence') {
          walk(el, depth + 1); // transparent containers
        } else if (k === 'activity') {
          activities.push({ seq: seq++, key, k, name: actName, role: 'activity', raw: el });
          walk(el, depth + 1);
        }
      }
    }
  }

  walk(root, 0);
  return activities;
}

// ── Extract link/transition graph (BW6 DAG model) ─────────────────────────────
function extractLinkGraph(root, activities) {
  // BW6 uses <bpws:link name="..." sources/targets> inside <flow>
  const edges = []; // { from: name, to: name }

  function findLinks(node) {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node).filter(k => k !== '$')) {
      const els = Array.isArray(node[key]) ? node[key] : [node[key]];
      const k = key.toLowerCase();
      if (k === 'link' || k === 'transition') {
        for (const el of els) {
          const attrs = el['$'] || {};
          const from = attrs.from || attrs.source || attrs.sourceRef;
          const to   = attrs.to   || attrs.target || attrs.targetRef;
          if (from && to) edges.push({ from, to });
        }
      }
      for (const el of els) {
        if (el && typeof el === 'object') findLinks(el);
      }
    }
  }

  findLinks(root);
  return edges;
}

// ── Topological sort of activities using link graph ───────────────────────────
function topoSort(activities, edges) {
  if (edges.length === 0) return activities; // Already sequential

  const nameToAct = {};
  activities.forEach(a => { nameToAct[a.name] = a; });

  // Build adjacency
  const inDegree = {};
  const adj = {};
  activities.forEach(a => { inDegree[a.name] = 0; adj[a.name] = []; });

  for (const e of edges) {
    if (adj[e.from] !== undefined && inDegree[e.to] !== undefined) {
      adj[e.from].push(e.to);
      inDegree[e.to]++;
    }
  }

  // Kahn's algorithm
  const queue = activities.filter(a => inDegree[a.name] === 0).map(a => a.name);
  const result = [];

  while (queue.length > 0) {
    const n = queue.shift();
    if (nameToAct[n]) result.push(nameToAct[n]);
    for (const neighbor of (adj[n] || [])) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) queue.push(neighbor);
    }
  }

  // Include any remaining (cycles or disconnected)
  activities.forEach(a => {
    if (!result.includes(a)) result.push(a);
  });

  return result;
}

// ── Build a processor step object from a BW6 activity ─────────────────────────
function buildProcessor(act, artifact) {
  const k    = act.k;
  const name = act.name;
  const raw  = act.raw;
  const attrs = raw['$'] || {};

  // Trigger (receive) → sender config, not a step
  if (act.role === 'trigger') return null;

  // Reply → end step
  if (act.role === 'reply') {
    return { type: 'reply', label: name, config: {} };
  }

  // Invoke → receiver call
  if (act.role === 'invoke') {
    const pl  = (attrs.partnerLink || '').toLowerCase();
    const op  = (attrs.operation   || '').toLowerCase();
    const combined = pl + ' ' + op;
    let connType = 'HTTP';
    if (/jdbc|sql|db/i.test(combined))  connType = 'JDBC';
    else if (/jms|ems/i.test(combined)) connType = 'JMS';
    else if (/sftp|ftp/i.test(combined)) connType = 'SFTP';
    else if (/sap|bapi|rfc/i.test(combined)) connType = 'SAP';
    else if (/smtp|mail/i.test(combined)) connType = 'SMTP';
    return {
      type: 'invoke', label: name,
      config: { connType, partnerLink: attrs.partnerLink, operation: attrs.operation }
    };
  }

  // Assign → may contain XSLT via tibex:inputBinding or bpws:copy
  if (act.role === 'assign' || act.role === 'mapper') {
    const xslt = extractXsltFromNode(raw);
    if (xslt) {
      const safeName = `${artifact.name.replace(/[^a-zA-Z0-9]/g, '_')}_${name.replace(/[^a-zA-Z0-9]/g, '_')}.xsl`;
      return {
        type: 'xslt', label: name,
        config: { xslFile: safeName, xsltContent: xslt }
      };
    }
    // Plain assign (set variable)
    return { type: 'contentModifier', label: name, config: {} };
  }

  // Router
  if (act.role === 'router') {
    return { type: 'router', label: name, config: {} };
  }

  // Loop
  if (act.role === 'loop') {
    return { type: 'splitter', label: name, config: {} };
  }

  // Scope
  if (act.role === 'scope') {
    return { type: 'scope', label: name, config: {} };
  }

  // ── BW6 extensionActivity roles (from bw6ActivityRole) ─────────────────────
  if (act.role === 'log') {
    return { type: 'contentModifier', label: name, config: { isLog: true } };
  }

  if (act.role === 'xslt') {
    const xslt = extractXsltFromNode(raw);
    if (xslt) {
      const safeName = `${artifact.name.replace(/[^a-zA-Z0-9]/g, '_')}_${name.replace(/[^a-zA-Z0-9]/g, '_')}.xsl`;
      return { type: 'xslt', label: name, config: { xslFile: safeName, xsltContent: xslt } };
    }
    return { type: 'xslt', label: name, config: {} };
  }

  if (act.role === 'processCall') {
    return { type: 'processCall', label: name, config: {} };
  }

  if (act.role === 'throw') {
    return { type: 'throw', label: name, config: {} };
  }

  // invoke-* roles from extensionActivity
  if (act.role && act.role.startsWith('invoke-')) {
    const connMap = {
      'invoke-http':       'HTTP',
      'invoke-soap':       'SOAP',
      'invoke-jms':        'JMS',
      'invoke-jdbc':       'JDBC',
      'invoke-sftp':       'SFTP',
      'invoke-file-write': 'SFTP',
      'invoke-file-read':  'SFTP',
      'invoke-smtp':       'SMTP',
      'invoke-sap':        'SAP'
    };
    const connType = connMap[act.role] || 'HTTP';
    return { type: 'invoke', label: name, config: { connType } };
  }

  // Generic activity
  return { type: 'contentModifier', label: name, config: {} };
}

// ── Extract XSLT from a BW6 assign/mapper node ────────────────────────────────
function extractXsltFromNode(node) {
  if (!node || typeof node !== 'object') return null;

  // Check for tibex:inputBinding expression attribute (BW6 mapper)
  const inputBinding = findDeep(node, ['inputBinding', 'InputBinding']);
  for (const ib of inputBinding) {
    const attrs = ib['$'] || {};
    const expr = attrs.expression || attrs.Expression;
    if (expr && expr.includes('&lt;xsl:')) {
      return htmlUnescape(expr);
    }
    if (expr && expr.includes('<xsl:')) {
      return expr; // already unescaped
    }
  }

  // Check for tibex:Mapper expression attribute
  const mapper = findDeep(node, ['Mapper', 'mapper', 'XSLTMapping', 'xsltMapping']);
  for (const m of mapper) {
    const attrs = m['$'] || {};
    const expr = attrs.expression || attrs.Expression || attrs.xsl || attrs.xslt;
    if (expr && (expr.includes('&lt;xsl:') || expr.includes('<xsl:'))) {
      return htmlUnescape(expr);
    }
    // Also check text content
    const text = typeof m === 'string' ? m : (m['_'] || '');
    if (text && (text.includes('&lt;xsl:') || text.includes('<xsl:'))) {
      return htmlUnescape(text);
    }
  }

  // Recurse through copy elements
  const copies = findDeep(node, ['copy', 'Copy']);
  for (const c of copies) {
    const attrs = c['$'] || {};
    for (const attrVal of Object.values(attrs)) {
      if (typeof attrVal === 'string' && (attrVal.includes('&lt;xsl:') || attrVal.includes('<xsl:'))) {
        return htmlUnescape(attrVal);
      }
    }
  }

  return null;
}

// ── Extract all XSLT transforms from process (for ZIP .xsl files) ─────────────
function extractXsltTransforms(root, artifact) {
  const xslts = [];
  let idx = 0;

  function walkForXslt(node) {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node).filter(k => k !== '$')) {
      const els = Array.isArray(node[key]) ? node[key] : [node[key]];
      const k = key.toLowerCase();

      for (const el of els) {
        if (!el || typeof el !== 'object') continue;
        if (k === 'assign' || k === 'mapper' || k === 'tns:mapper' || k === 'inputbinding') {
          const xslt = extractXsltFromNode(el);
          if (xslt) {
            const safeArtName = artifact.name.replace(/[^a-zA-Z0-9]/g, '_');
            const attrs = el['$'] || {};
            const actName = (attrs.name || `Transform_${idx + 1}`).replace(/[^a-zA-Z0-9]/g, '_');
            xslts.push({
              filename: `${safeArtName}_${actName}.xsl`,
              content: xslt,
              activityName: actName
            });
            idx++;
          }
        }
        walkForXslt(el);
      }
    }
  }

  walkForXslt(root);
  return xslts;
}

// ── Extract fault handlers ─────────────────────────────────────────────────────
function extractFaultHandlers(root, artifact) {
  const handlers = [];

  function walkForFaults(node) {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node).filter(k => k !== '$')) {
      const k = key.toLowerCase();
      const els = Array.isArray(node[key]) ? node[key] : [node[key]];

      if (k === 'faulthandlers' || k === 'catch' || k === 'catchall') {
        for (const el of els) {
          const attrs = el['$'] || {};
          handlers.push({
            type: k === 'catchall' ? 'catchAll' : 'catch',
            faultName: attrs.faultName || attrs.faultname || attrs.name || 'GenericFault',
            faultVariable: attrs.faultVariable || null
          });
        }
      }

      for (const el of els) {
        if (el && typeof el === 'object') walkForFaults(el);
      }
    }
  }

  walkForFaults(root);
  return handlers;
}

// ── Extract sender trigger config ─────────────────────────────────────────────
function extractSenderConfig(root, artifact) {
  const receives = findDeep(root, ['receive', 'Receive', 'pick', 'Pick']);
  if (receives.length === 0) {
    // Schedule / timer trigger
    const timers = findDeep(root, ['timer', 'Timer', 'schedule', 'Schedule']);
    if (timers.length > 0) {
      return { type: 'Schedule', triggerType: 'Schedule', frequency: '0 0 * * *' };
    }
    return { type: 'HTTP', triggerType: 'API', path: `/${artifact.name}`, method: 'POST' };
  }

  const rcv = receives[0];
  const attrs = rcv['$'] || {};
  const pl = (attrs.partnerLink || '').toLowerCase();
  const op = (attrs.operation   || '').toLowerCase();
  const combined = pl + ' ' + op;

  if (/jms|ems|queue|topic/i.test(combined))  return { type: 'JMS',  triggerType: 'Event',    queue: pl };
  if (/sftp|ftp|file/i.test(combined))        return { type: 'SFTP', triggerType: 'Listener', directory: '/inbound' };
  return { type: 'HTTP', triggerType: 'API', path: `/${artifact.name}`, method: 'POST' };
}

// ── Extract receiver (invoke) configs ─────────────────────────────────────────
function extractReceiverConfigs(root, artifact) {
  const invokes = findDeep(root, ['invoke', 'Invoke']);
  const configs = [];
  const seen = new Set();

  for (const inv of invokes) {
    const attrs = inv['$'] || {};
    const pl = (attrs.partnerLink || '').toLowerCase();
    const op = (attrs.operation   || '').toLowerCase();
    const key = `${pl}:${op}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (/jdbc|sql|db/i.test(pl + op))   configs.push({ type: 'JDBC', partnerLink: pl, operation: op });
    else if (/jms|ems/i.test(pl + op))  configs.push({ type: 'JMS',  queue: pl });
    else if (/sftp|ftp/i.test(pl + op)) configs.push({ type: 'SFTP', directory: '/outbound' });
    else if (/sap|bapi|rfc/i.test(pl + op)) configs.push({ type: 'SAP', function: op });
    else if (/smtp|mail/i.test(pl + op)) configs.push({ type: 'SMTP', host: '{{SMTP_HOST}}' });
    else configs.push({ type: 'HTTP', url: `{{${pl.toUpperCase()}_URL}}` });
  }

  if (configs.length === 0) {
    configs.push({ type: 'HTTP', url: '{{RECEIVER_URL}}' });
  }

  return configs;
}

// ── Completeness scoring ───────────────────────────────────────────────────────
function calculateCompleteness(result) {
  let score = 100;
  // Deduct for unresolved connectors
  const unmapped = result.connectorTypes.filter(t => /mongo|kafka|s3|aws/i.test(t)).length;
  score -= unmapped * 15;
  // Award for XSLT extraction
  if (result.hasXslt) score = Math.min(100, score + 5);
  return Math.max(30, score);
}

// ── Fallback when no raw_xml ───────────────────────────────────────────────────
function buildBw6FallbackData(artifact, base) {
  const connTypes = (artifact.connector_types || '').split(',').filter(Boolean);
  return {
    ...base,
    _source: 'metadata_fallback',
    connectorTypes: connTypes.length > 0 ? connTypes : ['HTTP'],
    triggerType: artifact.trigger_type || 'API',
    senderConfig: { type: 'HTTP', triggerType: artifact.trigger_type || 'API', path: `/${artifact.name}`, method: 'POST' },
    receiverConfigs: connTypes.map(t => ({ type: t })),
    processors: [],
    completenessScore: 50
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function findDeep(node, keys) {
  const results = [];
  if (!node || typeof node !== 'object') return results;
  for (const key of Object.keys(node).filter(k => k !== '$')) {
    const lk = key.toLowerCase();
    const els = Array.isArray(node[key]) ? node[key] : [node[key]];
    if (keys.some(k => k.toLowerCase() === lk)) {
      results.push(...els.filter(e => e && typeof e === 'object'));
    }
    for (const el of els) {
      if (el && typeof el === 'object') results.push(...findDeep(el, keys));
    }
  }
  return results;
}

module.exports = { extractBw6PlatformData, htmlUnescape };
