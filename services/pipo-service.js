'use strict';
/**
 * SAP PI/PO Service — deep multi-file XI Repository / ESR export ZIP parsing.
 * Handles: XI 3.0, PI 7.x, PO 7.5 — .tpz, .zip, single XML exports.
 * Parses: IntegrationScenario, IntegrationProcess (ccBPM), MessageInterface,
 *         MessageMapping, CommunicationChannel, InterfaceMapping.
 */

const fs      = require('fs');
const path    = require('path');
const AdmZip  = require('adm-zip');
const xml2js  = require('xml2js');
const { pool } = require('../database/db');
const { computeComplexityScore, classifyComplexity } = require('../parsers/boomi');

// ── Parse uploaded file and persist ──────────────────────────────────────────
async function parseAndPersist(filePath, originalName, projectId, sourceName) {
  const artifacts = await deepParse(filePath, originalName);

  const srcRes = await pool.query(
    `INSERT INTO source_connections (project_id, type, name, platform, config, status, artifacts_found, last_synced_at)
     VALUES ($1, 'zip', $2, 'pipo', $3, 'synced', $4, NOW()) RETURNING *`,
    [projectId, sourceName || originalName,
     JSON.stringify({ filename: originalName, size: fs.statSync(filePath).size, parser: 'deep-v2' }),
     artifacts.length]
  );
  const source = srcRes.rows[0];

  const inserted = [];
  for (const art of artifacts) {
    const r = await pool.query(
      `INSERT INTO artifacts
        (source_id, project_id, process_id, name, domain, platform, artifact_type, trigger_type,
         shapes_count, connectors_count, maps_count, has_scripting, scripting_detail, error_handling,
         dependencies_count, primary_connector, complexity_score, complexity_level, tshirt_size,
         effort_days, readiness, raw_metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
      [source.id, projectId, art.process_id, art.name, art.domain, 'pipo',
       art.artifact_type, art.trigger_type, art.shapes_count, art.connectors_count, art.maps_count,
       art.has_scripting, art.scripting_detail, art.error_handling, art.dependencies_count,
       art.primary_connector, art.complexity_score, art.complexity_level, art.tshirt_size,
       art.effort_days, art.readiness, JSON.stringify(art.raw_metadata || {})]
    );
    inserted.push(r.rows[0]);
  }

  await pool.query('UPDATE projects SET updated_at = NOW() WHERE id = $1', [projectId]);
  return { source, artifacts: inserted, count: inserted.length };
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function deepParse(filePath, originalName) {
  const isZip = originalName.endsWith('.zip') || originalName.endsWith('.tpz') ||
                filePath.endsWith('.zip')  || filePath.endsWith('.tpz');
  if (isZip) return parseXiZip(filePath);
  return parseSingleXml(filePath);
}

// ── Parse XI Repository / ESR export ZIP ─────────────────────────────────────
async function parseXiZip(zipPath) {
  const zip     = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const artifacts = [];

  // Collect channels globally — used to enrich scenarios
  const channels = {}; // name → adapter type
  const mappings = {}; // name → { sourceMsg, targetMsg }

  // Pass 1: parse CommunicationChannel and MessageMapping metadata
  for (const entry of entries) {
    if (entry.entryName.includes('CommunicationChannel') && entry.entryName.endsWith('.xml')) {
      try {
        const xml  = entry.getData().toString('utf8');
        const chns = await extractChannels(xml);
        Object.assign(channels, chns);
      } catch (e) { /* ignore */ }
    }
    if ((entry.entryName.includes('MessageMapping') || entry.entryName.includes('InterfaceMapping')) &&
        entry.entryName.endsWith('.xml')) {
      try {
        const xml  = entry.getData().toString('utf8');
        const maps = await extractMappingMeta(xml);
        Object.assign(mappings, maps);
      } catch (e) { /* ignore */ }
    }
  }

  // Pass 2: parse scenarios and integration processes
  const scenarioEntries = entries.filter(e => {
    const n = e.entryName;
    return n.endsWith('.xml') &&
      !n.includes('pom.xml') && !n.includes('MANIFEST') &&
      (n.includes('IntegrationScenario') || n.includes('IntegrationProcess') ||
       n.includes('Scenario') || n.includes('Interface') ||
       (!n.includes('/') || n.split('/').length <= 4));
  });

  for (const entry of scenarioEntries) {
    try {
      const xml  = entry.getData().toString('utf8');
      const arts = await extractFromXml(xml, channels, mappings);
      artifacts.push(...arts);
    } catch (e) {
      console.warn(`[PIPO] Failed to parse ${entry.entryName}:`, e.message);
    }
  }

  return artifacts.length > 0 ? deduplicate(artifacts) : fallbackArtifacts(zipPath);
}

// ── Parse single XML ──────────────────────────────────────────────────────────
async function parseSingleXml(xmlPath) {
  const xml = fs.readFileSync(xmlPath, 'utf8');
  return extractFromXml(xml, {}, {});
}

// ── Extract channels from CommunicationChannel XML ───────────────────────────
async function extractChannels(xmlStr) {
  const p   = makeParser();
  const doc = await p.parseStringPromise(xmlStr);
  const channels = {};

  const tryRoots = [doc['CommunicationChannel'], doc['xi:CommunicationChannel'],
                    doc['rfc:Channel'], doc['ns0:CommunicationChannel']];
  for (const root of tryRoots) {
    if (!root) continue;
    const list = Array.isArray(root) ? root : [root];
    for (const ch of list) {
      const attrs  = ch['$'] || {};
      const name   = attrs.name || attrs['Name'] || 'unknown';
      const adapter = detectAdapterFromChannel(ch);
      channels[name] = adapter;
    }
  }
  return channels;
}

// ── Extract mapping metadata ──────────────────────────────────────────────────
async function extractMappingMeta(xmlStr) {
  const p   = makeParser();
  const doc = await p.parseStringPromise(xmlStr);
  const maps = {};

  for (const [rootKey, root] of Object.entries(doc)) {
    if (!root || typeof root !== 'object') continue;
    const list = Array.isArray(root) ? root : [root];
    for (const m of list) {
      const attrs = m['$'] || {};
      const name  = attrs.name || attrs['Name'] || rootKey;
      maps[name] = { exists: true };
    }
  }
  return maps;
}

// ── Core XML extractor: handles multiple XI/PO XML formats ───────────────────
async function extractFromXml(xmlStr, channels, mappings) {
  const p   = makeParser();
  let doc;
  try { doc = await p.parseStringPromise(xmlStr); }
  catch (e) { return []; }

  const artifacts = [];

  // Try each known root element
  for (const [rootKey, root] of Object.entries(doc)) {
    if (!root || typeof root !== 'object') continue;

    const rk = rootKey.toLowerCase().replace(/^[^:]+:/, ''); // strip namespace prefix

    if (rk === 'integrationrepository') {
      artifacts.push(...parseIntegrationRepository(root, channels, mappings));
    } else if (rk === 'integrationscenario') {
      const art = parseScenario(root, channels, mappings);
      if (art) artifacts.push(art);
    } else if (rk === 'integrationprocess') {
      // ccBPM process
      const art = parseCcBpmProcess(root, channels, mappings);
      if (art) artifacts.push(art);
    } else if (rk === 'message' || rk.includes('interface')) {
      // MessageInterface — count as artifact
      const art = parseMessageInterface(root, channels);
      if (art) artifacts.push(art);
    }
  }

  return artifacts;
}

// ── IntegrationRepository root (multi-scenario export) ───────────────────────
function parseIntegrationRepository(root, channels, mappings) {
  const artifacts = [];
  const scenarios = getElements(root, ['IntegrationScenario', 'xi:IntegrationScenario']);
  const processes = getElements(root, ['IntegrationProcess', 'xi:IntegrationProcess']);

  for (const s of scenarios) {
    const art = parseScenario(s, channels, mappings);
    if (art) artifacts.push(art);
  }
  for (const p of processes) {
    const art = parseCcBpmProcess(p, channels, mappings);
    if (art) artifacts.push(art);
  }
  return artifacts;
}

// ── Parse a single IntegrationScenario ───────────────────────────────────────
function parseScenario(scenario, channels, mappings) {
  const attrs     = scenario['$'] || {};
  const name      = attrs.name || attrs.Name || 'Unknown_Scenario';
  if (name.startsWith('_') || name === 'Unknown_Scenario') return null;

  const namespace = attrs.namespace || attrs.Namespace || '';

  // Collect actions / steps
  const actions     = getElements(scenario, ['xi:Action', 'Action', 'xi:IntegrationStep', 'IntegrationStep']);
  const outInterfaces = getElements(scenario, ['xi:OutboundInterface', 'OutboundInterface']);
  const inInterfaces  = getElements(scenario, ['xi:InboundInterface',  'InboundInterface']);
  const channels_el   = getElements(scenario, ['xi:CommunicationChannel', 'CommunicationChannel']);
  const mappingRefs   = getElements(scenario, ['xi:MappingProgram', 'MappingProgram', 'xi:InterfaceMapping', 'InterfaceMapping']);
  const conditions    = getElements(scenario, ['xi:Condition', 'Condition', 'xi:BranchCondition', 'BranchCondition']);

  // Detect adapter types from channel references
  const adapterTypes = new Set();
  for (const ch of channels_el) {
    const chAttrs = ch['$'] || {};
    const chName  = chAttrs.name || chAttrs.refName || '';
    if (channels[chName]) adapterTypes.add(channels[chName]);
  }

  // Fallback: detect from interface type attributes
  for (const iface of [...outInterfaces, ...inInterfaces]) {
    const ifAttrs = iface['$'] || {};
    const t = (ifAttrs.type || ifAttrs.adapterType || '').toUpperCase();
    if (t) adapterTypes.add(detectAdapterType(t));
  }

  const senderTypes   = outInterfaces.map(i => (i['$'] || {}).type || 'IDoc');
  const primarySender = senderTypes[0] || 'IDoc';

  // Scripting: XSLT / Java / ABAP mappings
  let scriptingLevel  = 0;
  let scriptingDetail = null;
  const mapsCount     = mappingRefs.length || (Object.keys(mappings).length > 0 ? 1 : 0);
  const hasXslt = mappingRefs.some(m => {
    const mAttrs = m['$'] || {};
    const type   = (mAttrs.type || '').toLowerCase();
    return type.includes('xslt') || type.includes('java') || type.includes('abap');
  });
  if (hasXslt)          { scriptingLevel = 2; scriptingDetail = 'XSLT/Java mapping detected'; }
  else if (mapsCount > 0) { scriptingLevel = 1; scriptingDetail = `${mapsCount} graphical mapping(s)`; }

  // EDI check
  const hasEdi = [...senderTypes, ...inInterfaces.map(i => (i['$'] || {}).type || '')]
    .some(t => /EDI|EDIFACT|X12|ANSI|AS2/.test(t.toUpperCase()));
  if (hasEdi) { scriptingLevel = Math.max(scriptingLevel, 2); scriptingDetail = (scriptingDetail || '') + ' (EDI)'; }

  // Shapes / steps count
  const shapesCount     = Math.max(actions.length * 2 + outInterfaces.length + inInterfaces.length + mapsCount + 4, 6);
  const connectorsCount = Math.max(adapterTypes.size || (outInterfaces.length + inInterfaces.length), 2);
  const errorLevel      = conditions.length > 1 ? 2 : 1;

  // Trigger type
  let triggerType = 'Event';
  if (primarySender === 'RFC' || primarySender === 'REST' || primarySender === 'SOAP') triggerType = 'API';
  else if (primarySender === 'IDoc' || primarySender === 'JMS') triggerType = 'Event';
  else if (primarySender === 'File' || primarySender === 'SFTP' || primarySender === 'FTP') triggerType = 'Listener';

  const domain = inferDomain(name, namespace);

  const score = computeComplexityScore({
    shapes_count: shapesCount, connectors_count: connectorsCount,
    maps_complexity: mapsCount > 3 ? 3 : mapsCount > 1 ? 2 : mapsCount > 0 ? 1 : 0,
    scripting_level: scriptingLevel,
    error_handling_level: errorLevel,
    dependencies_count: conditions.length
  });
  const cl = classifyComplexity(score);

  return {
    process_id: `pipo-${name.replace(/\s+/g, '_')}-${Date.now()}`,
    name,
    domain,
    platform: 'pipo',
    artifact_type: 'IntegrationScenario',
    trigger_type: triggerType,
    shapes_count: shapesCount,
    connectors_count: connectorsCount,
    maps_count: mapsCount,
    has_scripting: scriptingLevel > 0,
    scripting_detail: scriptingDetail,
    error_handling: errorLevel >= 2 ? 'try_catch' : 'basic',
    dependencies_count: conditions.length,
    primary_connector: [...adapterTypes][0] || primarySender || 'IDoc',
    complexity_score: score,
    complexity_level: cl.level,
    tshirt_size: cl.tshirt,
    effort_days: cl.effort,
    readiness: hasEdi ? 'Manual' : scriptingLevel >= 2 ? 'Partial' : score > 55 ? 'Partial' : 'Auto',
    raw_metadata: {
      senderTypes, adapterTypes: [...adapterTypes], mapsCount, hasEdi,
      conditions: conditions.length, namespace, dataSource: 'file_upload'
    }
  };
}

// ── Parse a ccBPM IntegrationProcess ─────────────────────────────────────────
function parseCcBpmProcess(proc, channels, mappings) {
  const attrs = proc['$'] || {};
  const name  = attrs.name || attrs.Name || 'Unknown_Process';
  if (name.startsWith('_') || name === 'Unknown_Process') return null;

  const steps   = getElements(proc, ['xi:Step', 'Step', 'xi:BlockStep', 'BlockStep', 'xi:SendStep', 'SendStep', 'xi:ReceiveStep', 'ReceiveStep']);
  const forks   = getElements(proc, ['xi:Fork', 'Fork', 'xi:Switch', 'Switch']);
  const receives = getElements(proc, ['xi:ReceiveStep', 'ReceiveStep', 'xi:AbstractReceiveStep']);

  const shapesCount     = Math.max(steps.length * 2 + forks.length * 3 + 4, 8);
  const connectorsCount = Math.max(receives.length + 1, 2);
  const triggerType     = receives.length > 0 ? 'Event' : 'API';
  const domain          = inferDomain(name, '');

  const score = computeComplexityScore({
    shapes_count: shapesCount, connectors_count: connectorsCount,
    maps_complexity: 1, scripting_level: 1, error_handling_level: 1, dependencies_count: forks.length
  });
  const cl = classifyComplexity(score);

  return {
    process_id: `pipo-ccbpm-${name.replace(/\s+/g, '_')}-${Date.now()}`,
    name,
    domain,
    platform: 'pipo',
    artifact_type: 'ccBPM',
    trigger_type: triggerType,
    shapes_count: shapesCount,
    connectors_count: connectorsCount,
    maps_count: 1,
    has_scripting: true,
    scripting_detail: 'ccBPM orchestration process',
    error_handling: 'try_catch',
    dependencies_count: forks.length,
    primary_connector: 'XI',
    complexity_score: score,
    complexity_level: cl.level,
    tshirt_size: cl.tshirt,
    effort_days: cl.effort,
    readiness: 'Manual',
    raw_metadata: { steps: steps.length, forks: forks.length, receives: receives.length, dataSource: 'file_upload' }
  };
}

// ── Parse MessageInterface as standalone artifact ─────────────────────────────
function parseMessageInterface(iface, channels) {
  const attrs = iface['$'] || {};
  const name  = attrs.name || attrs.Name;
  if (!name || name.startsWith('_')) return null;

  const category = (attrs.category || '').toLowerCase();
  if (category === 'abstract') return null; // skip abstract interfaces

  const direction = attrs.direction || 'Outbound';
  const adapterType = detectAdapterFromChannel(iface) || 'XI';

  const score = computeComplexityScore({ shapes_count: 4, connectors_count: 1, maps_complexity: 1, scripting_level: 0, error_handling_level: 1, dependencies_count: 0 });
  const cl = classifyComplexity(score);

  return {
    process_id: `pipo-iface-${name.replace(/\s+/g, '_')}-${Date.now()}`,
    name,
    domain: inferDomain(name, ''),
    platform: 'pipo',
    artifact_type: 'MessageInterface',
    trigger_type: direction === 'Inbound' ? 'API' : 'Event',
    shapes_count: 4,
    connectors_count: 1,
    maps_count: 1,
    has_scripting: false,
    scripting_detail: null,
    error_handling: 'basic',
    dependencies_count: 0,
    primary_connector: adapterType,
    complexity_score: score,
    complexity_level: cl.level,
    tshirt_size: cl.tshirt,
    effort_days: cl.effort,
    readiness: 'Auto',
    raw_metadata: { direction, adapterType, dataSource: 'file_upload' }
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeParser() {
  return new xml2js.Parser({ explicitArray: true, ignoreAttrs: false, tagNameProcessors: [xml2js.processors.stripPrefix] });
}

function getElements(obj, keys) {
  for (const key of keys) {
    if (obj[key] && Array.isArray(obj[key]) && obj[key].length > 0) return obj[key];
  }
  return [];
}

function detectAdapterType(type) {
  if (/RFC|BAPI/.test(type))             return 'RFC';
  if (/IDOC|IDOCXI/.test(type))          return 'IDoc';
  if (/SOAP|HTTP/.test(type))            return 'SOAP';
  if (/JDBC|DB/.test(type))              return 'JDBC';
  if (/JMS|AMQP|MQ/.test(type))          return 'JMS';
  if (/FILE|FTP|SFTP|NFS/.test(type))    return 'File';
  if (/MAIL|SMTP/.test(type))            return 'SMTP';
  if (/REST|JSON/.test(type))            return 'REST';
  if (/EDI|AS2|X12|EDIFACT/.test(type)) return 'EDI';
  if (/SAP|R3|S4HANA/.test(type))       return 'SAP';
  return type || 'XI';
}

function detectAdapterFromChannel(ch) {
  if (!ch || typeof ch !== 'object') return 'XI';
  const all = JSON.stringify(ch).toUpperCase();
  if (/RFC/.test(all))    return 'RFC';
  if (/IDOC/.test(all))   return 'IDoc';
  if (/JDBC/.test(all))   return 'JDBC';
  if (/JMS/.test(all))    return 'JMS';
  if (/FILE/.test(all))   return 'File';
  if (/SFTP/.test(all))   return 'SFTP';
  if (/FTP/.test(all))    return 'FTP';
  if (/SOAP/.test(all))   return 'SOAP';
  if (/REST/.test(all))   return 'REST';
  if (/MAIL/.test(all))   return 'SMTP';
  return 'XI';
}

function inferDomain(name, namespace) {
  const n = (name + ' ' + namespace).toLowerCase();
  if (/customer|crm|salesforce|account|lead/.test(n))         return 'CRM';
  if (/invoice|payment|finance|gl|billing|revenue|fi/.test(n)) return 'FIN';
  if (/employee|hr|payroll|leave|workforce/.test(n))           return 'HR';
  if (/order|inventory|supply|warehouse|stock|purchase/.test(n)) return 'SCM';
  if (/edi|as2|b2b|vendor|supplier/.test(n))                   return 'EXT';
  if (/loan|credit|mortgage|trade|fraud/.test(n))              return 'FIN';
  return 'INT';
}

function deduplicate(artifacts) {
  const seen = new Set();
  return artifacts.filter(a => {
    const key = a.name + a.artifact_type;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fallbackArtifacts(filePath) {
  const size = fs.statSync(filePath).size;
  const score = 38; const cl = classifyComplexity(score);
  return [{
    process_id: `pipo-fallback-${Date.now()}`,
    name: path.basename(filePath, path.extname(filePath)),
    domain: 'INT', platform: 'pipo', artifact_type: 'IntegrationScenario', trigger_type: 'Event',
    shapes_count: 10, connectors_count: 2, maps_count: 2, has_scripting: false,
    scripting_detail: null, error_handling: 'basic', dependencies_count: 0,
    primary_connector: 'IDoc', complexity_score: score, complexity_level: cl.level,
    tshirt_size: cl.tshirt, effort_days: cl.effort, readiness: 'Auto',
    raw_metadata: { source: 'fallback', fileSize: size, dataSource: 'file_upload' }
  }];
}

module.exports = { parseAndPersist, deepParse };
