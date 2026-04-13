'use strict';
/**
 * TIBCO BW Service — deep multi-file project ZIP parsing.
 * Handles: TIBCO BusinessWorks 5.x project ZIPs (.zip), .process XML files,
 *          adapter configurations, shared resources, .substvar, .alias files.
 * Supports: HTTP, JDBC, JMS, SFTP/FTP, File, SMTP, SAP, Salesforce adapters.
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
     VALUES ($1, 'zip', $2, 'tibco', $3, 'synced', $4, NOW()) RETURNING *`,
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
         effort_days, readiness, raw_metadata, raw_xml, data_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
      [source.id, projectId, art.process_id, art.name, art.domain, 'tibco',
       art.artifact_type, art.trigger_type, art.shapes_count, art.connectors_count, art.maps_count,
       art.has_scripting, art.scripting_detail, art.error_handling, art.dependencies_count,
       art.primary_connector, art.complexity_score, art.complexity_level, art.tshirt_size,
       art.effort_days, art.readiness, JSON.stringify(art.raw_metadata || {}), art.raw_xml || null,
       art.raw_xml ? 'real' : 'mock']
    );
    inserted.push(r.rows[0]);
  }

  await pool.query('UPDATE projects SET updated_at = NOW() WHERE id = $1', [projectId]);
  return { source, artifacts: inserted, count: inserted.length };
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function deepParse(filePath, originalName) {
  const isZip = /\.(zip|ear|par)$/i.test(originalName) || /\.(zip|ear|par)$/i.test(filePath);
  if (isZip) return parseBwProjectZip(filePath);
  return parseSingleProcess(filePath);
}

// ── Parse BW project ZIP — auto-detects BW5 vs BW6 ──────────────────────────
async function parseBwProjectZip(zipPath) {
  const zip     = new AdmZip(zipPath);
  const entries = zip.getEntries();

  // BW6: project contains .bwp files (BPWS XML format)
  const bw6Entries = entries.filter(e => e.entryName.endsWith('.bwp'));
  if (bw6Entries.length > 0) {
    return parseBw6ProjectZip(zip, entries, zipPath);
  }

  // BW5: project contains .process files or BW XML
  return parseBw5ProjectZip(zip, entries, zipPath);
}

// ── Parse BW6 project ZIP (TIBCO BW Container Edition / BW 6.x) ─────────────
async function parseBw6ProjectZip(zip, entries, zipPath) {
  const artifacts = [];
  const xsdCount  = entries.filter(e => e.entryName.endsWith('.xsd')).length;
  const wsdlCount = entries.filter(e => e.entryName.endsWith('.wsdl')).length;

  // Collect service descriptor metadata from .bwext or .module files
  const moduleEntries = entries.filter(e =>
    e.entryName.endsWith('.bwext') || e.entryName.endsWith('.module') ||
    (e.entryName.endsWith('.xml') && e.entryName.includes('module'))
  );
  const moduleBindings = {}; // partnerLinkType → connector type
  for (const entry of moduleEntries) {
    try {
      const xml = entry.getData().toString('utf8');
      extractBw6Bindings(xml, moduleBindings);
    } catch (e) { /* ignore */ }
  }

  // Parse all .bwp process files
  const bwpEntries = entries.filter(e => e.entryName.endsWith('.bwp'));
  for (const entry of bwpEntries) {
    try {
      const xml  = entry.getData().toString('utf8');
      const arts = await extractBw6Processes(xml, entry.entryName, moduleBindings, { xsdCount, wsdlCount });
      // Store the raw .bwp XML on each artifact — conversion engine needs this for XSLT extraction
      arts.forEach(a => { a.raw_xml = xml; });
      artifacts.push(...arts);
    } catch (e) {
      console.warn(`[TIBCO BW6] Failed to parse ${entry.entryName}:`, e.message);
    }
  }

  if ((wsdlCount + xsdCount) > 3) {
    artifacts.forEach(a => {
      if (a.maps_count > 0) {
        a.scripting_detail = (a.scripting_detail || '') + ` (+${wsdlCount} WSDLs, ${xsdCount} XSDs)`;
      }
    });
  }

  return artifacts.length > 0 ? artifacts : fallbackArtifacts(zipPath);
}

// ── Extract connector bindings from BW6 module descriptor ────────────────────
function extractBw6Bindings(xmlStr, bindings) {
  const lines = xmlStr.split('\n');
  // Heuristic: look for binding references in module XML
  for (const line of lines) {
    if (/jdbc|database|sql/i.test(line))      bindings['jdbc'] = 'JDBC';
    if (/jms|activemq|tibco\.ems/i.test(line)) bindings['jms'] = 'JMS';
    if (/http|rest|soap/i.test(line))          bindings['http'] = 'HTTP';
    if (/ftp|sftp/i.test(line))                bindings['ftp'] = 'SFTP';
    if (/smtp|mail|email/i.test(line))         bindings['smtp'] = 'SMTP';
    if (/sap|bapi|rfc/i.test(line))            bindings['sap'] = 'SAP';
    if (/salesforce/i.test(line))              bindings['sf'] = 'Salesforce';
    if (/s3|aws/i.test(line))                  bindings['s3'] = 'S3';
    if (/kafka/i.test(line))                   bindings['kafka'] = 'Kafka';
    if (/mongodb|mongo/i.test(line))           bindings['mongo'] = 'MongoDB';
  }
}

// ── Extract processes from BW6 .bwp file (BPWS XML) ─────────────────────────
async function extractBw6Processes(xmlStr, entryName, moduleBindings, projectMeta) {
  const p = makeParser();
  let doc;
  try { doc = await p.parseStringPromise(xmlStr); }
  catch (e) { return []; }

  const artifacts = [];

  // Root element is <bpws:process> — after stripPrefix becomes 'process'
  const procEl = doc['process'];
  if (!procEl) return [];

  const procArr = Array.isArray(procEl) ? procEl : [procEl];
  for (const proc of procArr) {
    const art = analyseBw6Process(proc, entryName, moduleBindings, projectMeta);
    if (art) artifacts.push(art);
  }

  return artifacts;
}

// ── Analyse a single BW6 <bpws:process> element ──────────────────────────────
function analyseBw6Process(proc, entryName, moduleBindings, projectMeta) {
  const attrs = proc['$'] || {};
  // Name like "creditapp.module.MainProcess" — use last segment
  const fullName  = attrs.name || path.basename(entryName, '.bwp');
  const nameParts = fullName.split('.');
  const name      = nameParts[nameParts.length - 1] || fullName;

  if (!name || name.startsWith('_')) return null;

  const connectorTypes = new Set();
  let shapesCount    = 0;
  let mapsCount      = 0;
  let scriptingLevel = 0;
  let hasErrorHandler = false;
  let triggerType    = 'API';

  // Helper: recursively walk any XML node collecting activity info
  function walkNode(node) {
    if (!node || typeof node !== 'object') return;
    const keys = Object.keys(node).filter(k => k !== '$');
    for (const key of keys) {
      const els = Array.isArray(node[key]) ? node[key] : [node[key]];
      const k   = key.toLowerCase();

      // Trigger detection
      if (k === 'receive' || k === 'pick') {
        // <bpws:receive> = inbound trigger
        shapesCount++;
        for (const el of els) {
          const ea = (el && el['$']) ? el['$'] : {};
          const op = (ea.operation || ea.portType || '').toLowerCase();
          if (/timer|schedule|cron/i.test(op)) triggerType = 'Schedule';
          else if (/jms|ems|queue|topic/i.test(op)) { triggerType = 'Event'; connectorTypes.add('JMS'); }
          else if (/file|sftp|ftp/i.test(op)) { triggerType = 'Listener'; connectorTypes.add('SFTP'); }
          // Also check TIBCO extension attributes
          walkNode(el);
        }
      }

      // Outbound invoke
      if (k === 'invoke') {
        shapesCount += els.length;
        for (const el of els) {
          const ea = (el && el['$']) ? el['$'] : {};
          const pl = (ea.partnerLink || '').toLowerCase();
          const op = (ea.operation || ea.portType || '').toLowerCase();
          const combined = pl + ' ' + op;
          if (/jdbc|sql|db|database/i.test(combined))         connectorTypes.add('JDBC');
          else if (/jms|ems|queue|topic|activemq/i.test(combined)) connectorTypes.add('JMS');
          else if (/ftp|sftp/i.test(combined))                connectorTypes.add('SFTP');
          else if (/smtp|mail/i.test(combined))               connectorTypes.add('SMTP');
          else if (/sap|bapi|rfc/i.test(combined))            connectorTypes.add('SAP');
          else if (/salesforce|sfdc/i.test(combined))         connectorTypes.add('Salesforce');
          else if (/s3|aws/i.test(combined))                  connectorTypes.add('S3');
          else if (/kafka/i.test(combined))                   connectorTypes.add('Kafka');
          else if (/mongo/i.test(combined))                   connectorTypes.add('MongoDB');
          else                                                 connectorTypes.add('HTTP');
          walkNode(el);
        }
      }

      // Assign = data mapping / transform
      if (k === 'assign') {
        shapesCount += els.length;
        mapsCount   += els.length;
        scriptingLevel = Math.max(scriptingLevel, 1);
        for (const el of els) {
          // Count copy statements as mapping complexity
          const copies = el['copy'] || el['Copy'] || [];
          if (copies.length > 15) scriptingLevel = Math.max(scriptingLevel, 2);
        }
      }

      // TIBCO extension activities (tibex: → stripped to bare name)
      if (k === 'activity' || k.includes('activity')) {
        shapesCount += els.length;
        for (const el of els) {
          const ea   = (el && el['$']) ? el['$'] : {};
          const type = (ea.type || ea['xsi:type'] || key).toLowerCase();
          if (/jdbc|sql|database|db/i.test(type))              connectorTypes.add('JDBC');
          else if (/jms|ems|activemq/i.test(type))             connectorTypes.add('JMS');
          else if (/http|rest|soap/i.test(type))               connectorTypes.add('HTTP');
          else if (/ftp|sftp/i.test(type))                     connectorTypes.add('SFTP');
          else if (/file/i.test(type))                         connectorTypes.add('File');
          else if (/smtp|mail|email/i.test(type))              connectorTypes.add('SMTP');
          else if (/sap|bapi|rfc/i.test(type))                 connectorTypes.add('SAP');
          else if (/salesforce/i.test(type))                   connectorTypes.add('Salesforce');
          else if (/kafka/i.test(type))                        connectorTypes.add('Kafka');
          else if (/mongo/i.test(type))                        connectorTypes.add('MongoDB');
          if (/mapper|transform|map/i.test(type))              { mapsCount++; scriptingLevel = Math.max(scriptingLevel, 1); }
          if (/java|script|groovy/i.test(type))                scriptingLevel = 2;
          if (/timer|schedule|cron/i.test(type))               triggerType = 'Schedule';
          walkNode(el);
        }
      }

      // Mapper activity (TIBCO BW6 mapper element)
      if (k === 'mapper' || k === 'tns:mapper') {
        shapesCount += els.length;
        mapsCount   += els.length;
        scriptingLevel = Math.max(scriptingLevel, 1);
      }

      // Error handlers
      if (k === 'faulthandlers' || k === 'catch' || k === 'catchall') {
        hasErrorHandler = true;
        shapesCount++;
      }

      // Scope (wraps activities, can have fault handlers)
      if (k === 'scope') {
        shapesCount += els.length;
        for (const el of els) walkNode(el);
      }

      // Sequence / flow containers — count them as shapes
      if (k === 'sequence' || k === 'flow' || k === 'while' || k === 'repeatuntil' || k === 'if') {
        shapesCount++;
        for (const el of els) walkNode(el);
      }

      // Reply = output step
      if (k === 'reply') { shapesCount += els.length; }

      // Throw = error throw
      if (k === 'throw') { shapesCount += els.length; hasErrorHandler = true; }
    }
  }

  walkNode(proc);

  // Enrich connectors from module-level bindings
  for (const [, type] of Object.entries(moduleBindings)) {
    connectorTypes.add(type);
  }

  // Detect trigger from partnerLinks (BW6 pattern)
  const partnerLinks = proc['partnerLinks'] || proc['PartnerLinks'];
  if (partnerLinks) {
    const plArr = Array.isArray(partnerLinks) ? partnerLinks : [partnerLinks];
    for (const plGroup of plArr) {
      const links = plGroup['partnerLink'] || plGroup['PartnerLink'] || [];
      for (const link of links) {
        const la   = (link && link['$']) ? link['$'] : {};
        const plt  = (la.partnerLinkType || la.name || '').toLowerCase();
        if (/timer|schedule/i.test(plt))                      triggerType = 'Schedule';
        else if (/jms|ems|queue|topic/i.test(plt))            { triggerType = 'Event';    connectorTypes.add('JMS'); }
        else if (/file|sftp|ftp/i.test(plt))                  { triggerType = 'Listener'; connectorTypes.add('SFTP'); }
        else if (/jdbc|sql|db/i.test(plt))                    connectorTypes.add('JDBC');
        else if (/smtp|mail/i.test(plt))                      connectorTypes.add('SMTP');
        else if (/sap|bapi/i.test(plt))                       connectorTypes.add('SAP');
        else if (/salesforce/i.test(plt))                     connectorTypes.add('Salesforce');
        else if (/kafka/i.test(plt))                          connectorTypes.add('Kafka');
      }
    }
  }

  // Derive trigger from connector set if still default
  if (triggerType === 'API') {
    if (connectorTypes.has('JMS') && !connectorTypes.has('HTTP'))   triggerType = 'Event';
    if (connectorTypes.has('SFTP') && !connectorTypes.has('HTTP'))  triggerType = 'Listener';
  }

  const connectorsCount = Math.max(connectorTypes.size, 1);
  const estimatedShapes = Math.max(shapesCount, 5);
  const errorLevel      = hasErrorHandler ? 2 : 1;
  const mapsComplexity  = mapsCount > 3 ? 3 : mapsCount > 1 ? 2 : mapsCount > 0 ? 1 : 0;
  const primaryConnector = [...connectorTypes][0] || detectConnectorFromName(name);
  const domain           = inferDomain(name);
  const dependencies     = projectMeta.xsdCount > 0 ? Math.min(Math.floor(projectMeta.xsdCount / 2), 5) : 0;

  const score = computeComplexityScore({
    shapes_count: estimatedShapes, connectors_count: connectorsCount,
    maps_complexity: mapsComplexity, scripting_level: scriptingLevel,
    error_handling_level: errorLevel, dependencies_count: dependencies
  });
  const cl = classifyComplexity(score);

  const scriptingDetail = scriptingLevel >= 2
    ? 'Custom scripting / Java code detected'
    : mapsCount > 0 ? `${mapsCount} BW6 mapper(s)` : null;

  return {
    process_id: `tibco-${name.replace(/[\s/\\]+/g, '_')}-${Date.now()}`,
    name,
    domain,
    platform:          'tibco',
    artifact_type:     'BW6Process',
    trigger_type:      triggerType,
    shapes_count:      estimatedShapes,
    connectors_count:  connectorsCount,
    maps_count:        mapsCount,
    has_scripting:     scriptingLevel > 0,
    scripting_detail:  scriptingDetail,
    error_handling:    errorLevel >= 2 ? 'try_catch' : 'basic',
    dependencies_count: dependencies,
    primary_connector: primaryConnector,
    complexity_score:  score,
    complexity_level:  cl.level,
    tshirt_size:       cl.tshirt,
    effort_days:       cl.effort,
    readiness:         scriptingLevel >= 2 ? 'Partial' : score > 60 ? 'Manual' : 'Auto',
    raw_metadata: {
      connectorTypes: [...connectorTypes], triggerType, mapsCount,
      hasErrorHandler, scriptingLevel, bwVersion: '6.x',
      dataSource: 'file_upload'
    }
  };
}

// ── Parse BW5 project ZIP (original logic extracted) ─────────────────────────
async function parseBw5ProjectZip(zip, entries, zipPath) {
  const artifacts = [];

  // Collect shared resource metadata
  const sharedResources = {}; // alias → adapter type
  const subvarCount = entries.filter(e => e.entryName.endsWith('.substvar')).length;
  const wsdlCount   = entries.filter(e => e.entryName.endsWith('.wsdl')).length;
  const xsdCount    = entries.filter(e => e.entryName.endsWith('.xsd')).length;
  const aliasFiles  = entries.filter(e => e.entryName.endsWith('.alias'));

  for (const entry of aliasFiles) {
    try {
      const xml = entry.getData().toString('utf8');
      const res = await extractSharedResource(xml);
      Object.assign(sharedResources, res);
    } catch (e) { /* ignore */ }
  }

  // Also scan .process files
  const processEntries = entries.filter(e =>
    e.entryName.endsWith('.process') ||
    (e.entryName.endsWith('.xml') && (
      e.entryName.includes('/Processes/') || e.entryName.includes('/processes/') ||
      e.entryName.includes('ProcessDef') || e.entryName.includes('BusinessWorksProject')
    ))
  );

  for (const entry of processEntries) {
    try {
      const xml  = entry.getData().toString('utf8');
      const arts = await extractProcesses(xml, sharedResources, { subvarCount, wsdlCount, xsdCount });
      // Store raw ProcessDef XML on each artifact
      arts.forEach(a => { a.raw_xml = xml; });
      artifacts.push(...arts);
    } catch (e) {
      console.warn(`[TIBCO BW5] Failed to parse ${entry.entryName}:`, e.message);
    }
  }

  // Enrich with schema complexity if xsd/wsdl found
  if ((wsdlCount + xsdCount) > 3) {
    artifacts.forEach(a => {
      if (a.maps_count > 0) {
        a.raw_metadata.wsdlCount = wsdlCount;
        a.raw_metadata.xsdCount  = xsdCount;
        a.scripting_detail = (a.scripting_detail || '') +
          ` (+${wsdlCount} WSDLs, ${xsdCount} XSDs)`;
      }
    });
  }

  return artifacts.length > 0 ? artifacts : fallbackArtifacts(zipPath);
}

// ── Parse single .process XML ─────────────────────────────────────────────────
async function parseSingleProcess(filePath) {
  const xml = fs.readFileSync(filePath, 'utf8');
  return extractProcesses(xml, {}, {});
}

// ── Extract shared resource adapter type ─────────────────────────────────────
async function extractSharedResource(xmlStr) {
  const p   = makeParser();
  const doc = await p.parseStringPromise(xmlStr);
  const res = {};

  for (const [rootKey, root] of Object.entries(doc)) {
    if (!root || typeof root !== 'object') continue;
    const list = Array.isArray(root) ? root : [root];
    for (const item of list) {
      const attrs  = item['$'] || {};
      const name   = attrs.name || attrs.alias || rootKey;
      const type   = detectResourceType(rootKey, item);
      if (name && type) res[name] = type;
    }
  }
  return res;
}

// ── Core: extract processes from XML string ───────────────────────────────────
async function extractProcesses(xmlStr, sharedResources, projectMeta) {
  const p = makeParser();
  let doc;
  try { doc = await p.parseStringPromise(xmlStr); }
  catch (e) { return []; }

  const artifacts = [];

  for (const [rootKey, root] of Object.entries(doc)) {
    const rk = rootKey.replace(/^[^:]+:/, '').toLowerCase();

    if (rk === 'businessworksproject') {
      // Top-level BW project file — may contain multiple ProcessDefs
      const procs = getElements(root, ['ProcessDef', 'bw:ProcessDef', 'pd:ProcessDef']);
      for (const proc of procs) {
        const art = analyseProcess(proc, sharedResources, projectMeta);
        if (art) artifacts.push(art);
      }
    } else if (rk === 'processdef') {
      const art = analyseProcess(root, sharedResources, projectMeta);
      if (art) artifacts.push(art);
    }
  }

  return artifacts;
}

// ── Analyse a single ProcessDef element ──────────────────────────────────────
function analyseProcess(proc, sharedResources, projectMeta) {
  const attrs = proc['$'] || {};
  const name  = attrs.name || attrs.Name;
  if (!name || name.startsWith('_') || name === 'Process') return null;

  // Collect all activity elements across all keys
  const allKeys    = Object.keys(proc).filter(k => k !== '$');
  const activities = [];
  let   shapesCount = 0;

  for (const key of allKeys) {
    const els = Array.isArray(proc[key]) ? proc[key] : [proc[key]];
    shapesCount += els.length;
    const k = key.toLowerCase().replace(/^[^:]+:/, '');
    if (k === 'activity' || k === 'starter' || k === 'endevent' || k === 'transition') {
      activities.push(...els.map(e => ({ key, ...e })));
    }
  }

  // Detect trigger from starter
  const starter    = getElements(proc, ['pd:starter', 'starter', 'bw:starter', 'Starter']);
  const triggerEl  = starter[0] || {};
  const triggerAttrs = triggerEl['$'] || {};
  const starterType  = triggerAttrs.type || triggerAttrs['xsi:type'] || '';

  let triggerType = 'API';
  if (/timer|schedule|cron/i.test(starterType))        triggerType = 'Schedule';
  else if (/jms|ems|queue|topic/i.test(starterType))   triggerType = 'Event';
  else if (/file|sftp|ftp/i.test(starterType))         triggerType = 'Listener';
  else if (/http|soap|rest/i.test(starterType))        triggerType = 'API';

  // Connector detection from activities
  const connectorTypes = new Set();
  let mapsCount      = 0;
  let scriptingLevel = 0;
  let xpathMappings  = 0;
  let hasErrorHandler = false;

  for (const key of allKeys) {
    const els = Array.isArray(proc[key]) ? proc[key] : [proc[key]];
    const k   = key.toLowerCase().replace(/^[^:]+:/, '');

    // Group (error handler scope)
    if (k === 'group' || k.includes('catch')) {
      hasErrorHandler = true;
    }

    for (const el of els) {
      const elAttrs = (el && el['$']) ? el['$'] : {};
      const actType = (elAttrs.type || elAttrs['xsi:type'] || key).toLowerCase();

      if (/jdbc|sql|database|db/i.test(actType))                    connectorTypes.add('JDBC');
      else if (/http|soap|rest|service/i.test(actType))             connectorTypes.add('HTTP');
      else if (/jms|ems|activemq|tibco\.rv/i.test(actType))        connectorTypes.add('JMS');
      else if (/smtp|mail|email/i.test(actType))                    connectorTypes.add('SMTP');
      else if (/sftp|ftp/i.test(actType))                           connectorTypes.add('SFTP');
      else if (/file/i.test(actType))                               connectorTypes.add('File');
      else if (/sap|bapi|rfc/i.test(actType))                       connectorTypes.add('SAP');
      else if (/salesforce/i.test(actType))                         connectorTypes.add('Salesforce');
      else if (/s3|aws/i.test(actType))                             connectorTypes.add('S3');

      if (/mapper|transform|xslt|map/i.test(actType)) {
        mapsCount++;
        // Count xpath expressions inside mapper
        const xpathEl = el['pd:xpath'] || el['xpath'] || el['bw:xpath'] || [];
        if (xpathEl.length > 0) {
          const xAttrs = (xpathEl[0] && xpathEl[0]['$']) ? xpathEl[0]['$'] : {};
          const mappingCount = parseInt(xAttrs.mappings || xAttrs.count || 0);
          xpathMappings += mappingCount;
          if (mappingCount > 30) scriptingLevel = Math.max(scriptingLevel, 2);
          else if (mappingCount > 0) scriptingLevel = Math.max(scriptingLevel, 1);
        } else {
          scriptingLevel = Math.max(scriptingLevel, 1);
        }
      }

      if (/javacode|script|groovy|javascript/i.test(actType)) {
        scriptingLevel = 2;
      }

      if (/catch|faulthandler|errorhandler/i.test(actType) || k.includes('group')) {
        hasErrorHandler = true;
      }
    }
  }

  // Also add connector types from shared resources referenced
  for (const [alias, type] of Object.entries(sharedResources)) {
    if (JSON.stringify(proc).includes(alias)) connectorTypes.add(type);
  }

  // Shapes: use actual count or estimate from activities
  const estimatedShapes = Math.max(shapesCount, activities.length * 2, 4);

  // Enrich trigger from starter connector type
  if (connectorTypes.has('JMS') && triggerType === 'API')      triggerType = 'Event';
  if (connectorTypes.has('SFTP') && triggerType === 'API')     triggerType = 'Listener';
  if (connectorTypes.has('File') && triggerType === 'API')     triggerType = 'Listener';

  const connectorsCount = Math.max(connectorTypes.size, 1);
  const errorLevel      = hasErrorHandler ? 2 : 1;
  const mapsComplexity  = xpathMappings > 30 ? 3 : mapsCount > 2 ? 2 : mapsCount > 0 ? 1 : 0;

  // Module/shared variable dependencies
  const dependencies = Object.keys(sharedResources).length > 0
    ? Math.min(Object.keys(sharedResources).length, 5)
    : (projectMeta.subvarCount || 0);

  const primaryConnector = [...connectorTypes][0] || detectConnectorFromName(name);
  const domain           = inferDomain(name);

  const score = computeComplexityScore({
    shapes_count: estimatedShapes, connectors_count: connectorsCount,
    maps_complexity: mapsComplexity, scripting_level: scriptingLevel,
    error_handling_level: errorLevel, dependencies_count: dependencies
  });
  const cl = classifyComplexity(score);

  const scriptingDetail = scriptingLevel >= 2
    ? (xpathMappings > 0 ? `${xpathMappings} XPath mappings, custom scripting` : 'Custom scripting detected')
    : (mapsCount > 0 ? `${mapsCount} TIBCO mapper(s)` : null);

  return {
    process_id: `tibco-${name.replace(/[\s/\\]+/g, '_')}-${Date.now()}`,
    name: path.basename(name, '.process'),
    domain,
    platform: 'tibco',
    artifact_type: 'ProcessDef',
    trigger_type: triggerType,
    shapes_count: estimatedShapes,
    connectors_count: connectorsCount,
    maps_count: mapsCount,
    has_scripting: scriptingLevel > 0,
    scripting_detail: scriptingDetail,
    error_handling: errorLevel >= 2 ? 'try_catch' : 'basic',
    dependencies_count: dependencies,
    primary_connector: primaryConnector,
    complexity_score: score,
    complexity_level: cl.level,
    tshirt_size: cl.tshirt,
    effort_days: cl.effort,
    readiness: scriptingLevel >= 2 ? 'Partial' : score > 60 ? 'Manual' : 'Auto',
    raw_metadata: {
      connectorTypes: [...connectorTypes], triggerType, mapsCount, xpathMappings,
      hasErrorHandler, starterType, scriptingLevel, dataSource: 'file_upload',
      subvarCount: projectMeta.subvarCount || 0
    }
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

function detectResourceType(rootKey, item) {
  const key = rootKey.toLowerCase();
  if (/jdbc|database|db/.test(key))     return 'JDBC';
  if (/jms|ems|queue|topic/.test(key))  return 'JMS';
  if (/http|soap|wsdl/.test(key))       return 'HTTP';
  if (/ftp|sftp/.test(key))             return 'SFTP';
  if (/file/.test(key))                 return 'File';
  if (/smtp|mail/.test(key))            return 'SMTP';
  if (/sap|bapi|rfc/.test(key))         return 'SAP';
  return null;
}

function detectConnectorFromName(name) {
  const n = name.toLowerCase();
  if (/sap|bapi|rfc/.test(n))           return 'SAP';
  if (/salesforce|sfdc/.test(n))        return 'Salesforce';
  if (/db|jdbc|sql|oracle/.test(n))     return 'JDBC';
  if (/jms|ems|kafka/.test(n))          return 'JMS';
  if (/ftp|sftp/.test(n))               return 'SFTP';
  if (/file/.test(n))                   return 'File';
  return 'HTTP';
}

function inferDomain(name) {
  const n = name.toLowerCase();
  if (/customer|crm|salesforce|account|lead/.test(n))          return 'CRM';
  if (/invoice|payment|finance|gl|billing|revenue|fi/.test(n)) return 'FIN';
  if (/employee|hr|payroll|leave|workforce/.test(n))            return 'HR';
  if (/order|inventory|supply|warehouse|stock|purchase/.test(n)) return 'SCM';
  if (/edi|as2|b2b|vendor|supplier/.test(n))                   return 'EXT';
  return 'INT';
}

function fallbackArtifacts(filePath) {
  const size = fs.statSync(filePath).size;
  const score = 42; const cl = classifyComplexity(score);
  return [{
    process_id: `tibco-fallback-${Date.now()}`,
    name: path.basename(filePath, path.extname(filePath)),
    domain: 'SCM', platform: 'tibco', artifact_type: 'ProcessDef', trigger_type: 'API',
    shapes_count: 12, connectors_count: 2, maps_count: 2, has_scripting: false,
    scripting_detail: null, error_handling: 'basic', dependencies_count: 1,
    primary_connector: 'HTTP', complexity_score: score, complexity_level: cl.level,
    tshirt_size: cl.tshirt, effort_days: cl.effort, readiness: 'Auto',
    raw_metadata: { source: 'fallback', fileSize: size, dataSource: 'file_upload' }
  }];
}

module.exports = { parseAndPersist, deepParse };
