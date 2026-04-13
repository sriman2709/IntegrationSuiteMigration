'use strict';
/**
 * MuleSoft Service — deep multi-file project ZIP parsing + artifact persistence.
 * Handles both single mule-config XML and full Anypoint project ZIPs.
 */

const fs      = require('fs');
const path    = require('path');
const AdmZip  = require('adm-zip');
const xml2js  = require('xml2js');
const { pool } = require('../database/db');
const { computeComplexityScore, classifyComplexity } = require('../parsers/boomi');

// ── Parse an uploaded file (XML or ZIP) and persist artifacts ─────────────────
async function parseAndPersist(filePath, originalName, projectId, sourceName) {
  const artifacts = await deepParse(filePath, originalName);

  const srcRes = await pool.query(
    `INSERT INTO source_connections (project_id, type, name, platform, config, status, artifacts_found, last_synced_at)
     VALUES ($1, 'zip', $2, 'mulesoft', $3, 'synced', $4, NOW()) RETURNING *`,
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
      [source.id, projectId, art.process_id, art.name, art.domain, 'mulesoft',
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

// ── Deep parser entry point — handles ZIP or single XML ───────────────────────
async function deepParse(filePath, originalName) {
  const isZip = originalName.endsWith('.zip') || originalName.endsWith('.jar') || filePath.endsWith('.zip') || filePath.endsWith('.jar');
  if (isZip) return parseProjectZip(filePath);
  return parseSingleXml(filePath);
}

// ── Parse full MuleSoft project ZIP (Anypoint Studio export) ─────────────────
async function parseProjectZip(zipPath) {
  const zip        = new AdmZip(zipPath);
  const entries    = zip.getEntries();
  const artifacts  = [];

  // If the ZIP only wraps a single JAR, extract and recurse into it
  const innerJar = entries.find(e => e.entryName.endsWith('.jar') && !e.entryName.includes('/'));
  if (innerJar && entries.filter(e => !e.isDirectory).length === 1) {
    const tmpJar = zipPath + '_inner.jar';
    try {
      fs.writeFileSync(tmpJar, innerJar.getData());
      const result = await parseProjectZip(tmpJar);
      fs.unlinkSync(tmpJar);
      return result;
    } catch (e) {
      if (fs.existsSync(tmpJar)) fs.unlinkSync(tmpJar);
      console.warn('[MuleSoft] Failed to parse inner JAR:', e.message);
    }
  }

  // Find mule-artifact.json for project metadata
  let projectMeta = {};
  const metaEntry = entries.find(e => e.entryName.endsWith('mule-artifact.json'));
  if (metaEntry) {
    try { projectMeta = JSON.parse(metaEntry.getData().toString('utf8')); } catch (e) { /* ignore */ }
  }

  // Collect all Mule XML files — covers Mule 3 and Mule 4 project structures
  const muleXmlEntries = entries.filter(e => {
    const n = e.entryName;
    return (n.endsWith('.xml') || n.endsWith('.XML')) &&
      !n.includes('pom.xml') && !n.includes('log4j') &&
      (n.includes('src/main/mule') || n.includes('src/main/app') ||
       n.includes('/flows/') || n.includes('/mule/') ||
       (!n.includes('/') || n.split('/').length <= 3)); // root-level xml
  });

  for (const entry of muleXmlEntries) {
    try {
      const xml   = entry.getData().toString('utf8');
      const flows = await extractFlowsFromXml(xml, projectMeta);
      artifacts.push(...flows);
    } catch (e) {
      console.warn(`[MuleSoft] Failed to parse ${entry.entryName}:`, e.message);
    }
  }

  // Also check for .dwl DataWeave files to enrich scripting counts
  const dwlCount = entries.filter(e => e.entryName.endsWith('.dwl')).length;
  if (dwlCount > 0) {
    artifacts.forEach(a => {
      if (a.has_scripting) {
        a.scripting_detail = `${a.scripting_detail || 'DataWeave'} (+${dwlCount} .dwl files)`;
      }
    });
  }

  // Deduplicate by flow name — same XML can appear at root + src/main/mule/
  const seen = new Set();
  const unique = artifacts.filter(a => {
    if (seen.has(a.name)) return false;
    seen.add(a.name);
    return true;
  });

  return unique.length > 0 ? unique : fallbackArtifacts(zipPath);
}

// ── Parse single mule-config XML ─────────────────────────────────────────────
async function parseSingleXml(xmlPath) {
  const xml = fs.readFileSync(xmlPath, 'utf8');
  return extractFlowsFromXml(xml, {});
}

// ── Core: extract flows from a Mule XML string ───────────────────────────────
async function extractFlowsFromXml(xmlStr, projectMeta) {
  const parser = new xml2js.Parser({ explicitArray: true, ignoreAttrs: false, tagNameProcessors: [xml2js.processors.stripPrefix] });
  const doc    = await parser.parseStringPromise(xmlStr);

  // Mule 3: root = 'mule', Mule 4: root = 'mule' (same, different namespace)
  const root = doc['mule'] || doc['mule:mule'] || doc['module'] || {};

  const artifacts = [];

  // Main flows
  const flows    = root['flow']     || [];
  // Sub-flows add complexity to their parent
  const subFlows = root['sub-flow'] || [];
  // Error handlers at global scope
  const globalErrHandlers = root['error-handler'] || [];

  for (const flow of flows) {
    const art = analyseFlow(flow, 'Flow', projectMeta, subFlows.length, globalErrHandlers.length > 0);
    if (art) {
      art.raw_xml = extractFlowXml(xmlStr, art.name);
      artifacts.push(art);
    }
  }

  // Batch jobs (Mule 3) / batch:job (Mule 4)
  const batchJobs = root['batch:job'] || root['batch-job'] || [];
  for (const batch of batchJobs) {
    const art = analyseFlow(batch, 'Batch', projectMeta, 0, false);
    if (art) {
      art.raw_xml = extractFlowXml(xmlStr, art.name);
      artifacts.push(art);
    }
  }

  return artifacts;
}

// ── Extract the raw XML block for a named flow from the source XML string ─────
function extractFlowXml(xmlStr, flowName) {
  // Try to slice out the <flow name="flowName">...</flow> block
  // This preserves the real DataWeave scripts, connector configs etc. for conversion
  const escaped = flowName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<(?:[a-z]+:)?(?:flow|batch:job)[^>]*name=["']${escaped}["'][^>]*>.*?</(?:[a-z]+:)?(?:flow|batch:job)>`,
    'si'
  );
  const match = xmlStr.match(pattern);
  return match ? match[0] : xmlStr; // fallback: store full file XML
}

// ── Analyse a single flow element ─────────────────────────────────────────────
function analyseFlow(flow, artifactType, projectMeta, subFlowCount, hasGlobalErrHandler) {
  const attrs = flow['$'] || {};
  const name  = attrs.name || attrs['name'] || 'Unknown_Flow';
  if (name.startsWith('_') || name === 'Unknown_Flow') return null; // skip internal

  const childKeys     = Object.keys(flow).filter(k => k !== '$');
  let shapesCount     = 0;
  let connectorsCount = 0;
  let mapsCount       = 0;
  let hasScripting    = false;
  let scriptingLevel  = 0;
  let hasErrorHandler = hasGlobalErrHandler;
  let triggerType     = 'API';
  const connectorTypes = new Set();

  for (const key of childKeys) {
    const elements = Array.isArray(flow[key]) ? flow[key] : [flow[key]];
    shapesCount += elements.length;
    const k = key.toLowerCase();

    // Trigger detection
    if (k.includes('listener') || k.includes('http:listener'))         { triggerType = 'API';      connectorTypes.add('HTTP'); connectorsCount++; }
    if (k === 'scheduler' || k.includes('poll') || k.includes('cron') || k === 'fixed-frequency') { triggerType = 'Schedule'; }
    if (k.includes('jms') && k.includes('listener'))                   { triggerType = 'Event';    connectorTypes.add('JMS'); connectorsCount++; }
    if (k.includes('kafka') && (k.includes('listener') || k.includes('message'))) { triggerType = 'Event'; connectorTypes.add('Kafka'); connectorsCount++; }
    if (k.includes('file:') && k.includes('listener'))                 { triggerType = 'Listener'; connectorTypes.add('SFTP'); connectorsCount++; }
    if (k.includes('sftp:') && k.includes('listener'))                 { triggerType = 'Listener'; connectorTypes.add('SFTP'); connectorsCount++; }
    if (k.includes('ftp:') && k.includes('listener'))                  { triggerType = 'Listener'; connectorTypes.add('FTP'); connectorsCount++; }

    // Connector detection (outbound)
    if (k.includes('http:request') || k.includes('http:outbound'))     { connectorTypes.add('HTTP'); connectorsCount++; }
    if (k.includes('db:') || k.includes('jdbc'))                       { connectorTypes.add('JDBC'); connectorsCount++; }
    if (k.includes('sftp:') && !k.includes('listener'))                { connectorTypes.add('SFTP'); connectorsCount++; }
    if (k.includes('jms:') && !k.includes('listener'))                 { connectorTypes.add('JMS'); connectorsCount++; }
    if (k.includes('kafka:') && !k.includes('listener'))               { connectorTypes.add('Kafka'); connectorsCount++; }
    if (k.includes('salesforce:'))                                      { connectorTypes.add('Salesforce'); connectorsCount++; }
    if (k.includes('sap:'))                                             { connectorTypes.add('SAP'); connectorsCount++; }
    if (k.includes('s3:') || k.includes('aws:'))                       { connectorTypes.add('S3'); connectorsCount++; }
    if (k.includes('workday:'))                                         { connectorTypes.add('Workday'); connectorsCount++; }
    if (k.includes('servicenow:'))                                      { connectorTypes.add('ServiceNow'); connectorsCount++; }
    if (k.includes('mongo:') || k.includes('mongodb:'))                { connectorTypes.add('MongoDB'); connectorsCount++; }
    if (k.includes('file:read') || k.includes('file:write'))           { connectorTypes.add('File'); connectorsCount++; }

    // DataWeave / transforms
    if (k.includes('transform') || k.includes('ee:transform') || k.includes('dw:')) {
      mapsCount++;
      hasScripting = true;
      scriptingLevel = Math.max(scriptingLevel, 2);
    }

    // Scripting components
    if (k.includes('scripting:') || k.includes('groovy') || k.includes('script')) {
      hasScripting = true;
      scriptingLevel = Math.max(scriptingLevel, 2);
    }

    // Error handling
    if (k.includes('error-handler') || k.includes('on-error') || k.includes('catch')) {
      hasErrorHandler = true;
    }

    // Batch adds complexity
    if (k.includes('batch:') || k.includes('batch-step')) {
      shapesCount += 4;
      connectorsCount++;
    }
  }

  // Sub-flows referenced from this flow add complexity
  if (subFlowCount > 0) shapesCount += Math.min(subFlowCount * 2, 10);

  const errorLevel    = hasErrorHandler ? (artifactType === 'Batch' ? 2 : 1) : 0;
  const errorHandling = errorLevel >= 2 ? 'try_catch' : errorLevel === 1 ? 'basic' : 'none';
  const mapsComplexity= mapsCount > 3 ? 3 : mapsCount > 1 ? 2 : mapsCount > 0 ? 1 : 0;
  const primaryConn   = connectorTypes.size > 0 ? [...connectorTypes][0] : 'HTTP';
  const domain        = inferDomain(name);

  const score = computeComplexityScore({
    shapes_count: Math.max(shapesCount, 3), connectors_count: Math.max(connectorsCount, 1),
    maps_complexity: mapsComplexity, scripting_level: scriptingLevel,
    error_handling_level: errorLevel, dependencies_count: artifactType === 'Batch' ? 2 : 0
  });
  const cl = classifyComplexity(score);

  const dwNotes = mapsCount > 0 ? `${mapsCount} DataWeave transform(s)` : null;
  const scriptNote = hasScripting && mapsCount === 0 ? 'Custom scripting detected' : null;

  return {
    process_id:        `mule-${name.replace(/\s+/g, '_')}-${Date.now()}`,
    name,
    domain,
    platform:          'mulesoft',
    artifact_type:     artifactType,
    trigger_type:      triggerType,
    shapes_count:      Math.max(shapesCount, 3),
    connectors_count:  Math.max(connectorsCount, 1),
    maps_count:        mapsCount,
    has_scripting:     hasScripting,
    scripting_detail:  dwNotes || scriptNote,
    error_handling:    errorHandling,
    dependencies_count: artifactType === 'Batch' ? 2 : 0,
    primary_connector: primaryConn,
    complexity_score:  score,
    complexity_level:  cl.level,
    tshirt_size:       cl.tshirt,
    effort_days:       cl.effort,
    readiness:         scriptingLevel >= 2 ? 'Partial' : score > 55 ? 'Partial' : 'Auto',
    raw_metadata: {
      connectorTypes: [...connectorTypes], triggerType, mapsCount,
      hasErrorHandler, subFlowCount, artifactType,
      muleVersion: projectMeta?.minMuleVersion || projectMeta?.muleVersion || 'unknown',
      dataSource: 'file_upload'
    }
  };
}

function inferDomain(name) {
  const n = name.toLowerCase();
  if (/customer|crm|salesforce|account|lead/.test(n))       return 'CRM';
  if (/invoice|payment|finance|gl|billing|revenue|tax/.test(n)) return 'FIN';
  if (/employee|hr|payroll|leave|workforce/.test(n))         return 'HR';
  if (/order|inventory|supply|warehouse|stock|purchase/.test(n)) return 'SCM';
  if (/edi|as2|b2b|vendor|supplier/.test(n))                return 'EXT';
  if (/loan|credit|mortgage|trade|fraud|kyc/.test(n))       return 'FIN';
  return 'INT';
}

function fallbackArtifacts(filePath) {
  const size = fs.statSync(filePath).size;
  const score = 42; const cl = classifyComplexity(score);
  return [{
    process_id: `mule-fallback-${Date.now()}`, name: path.basename(filePath, path.extname(filePath)),
    domain: 'INT', platform: 'mulesoft', artifact_type: 'Flow', trigger_type: 'API',
    shapes_count: 8, connectors_count: 2, maps_count: 1, has_scripting: true,
    scripting_detail: 'DataWeave (estimated)', error_handling: 'basic', dependencies_count: 0,
    primary_connector: 'HTTP', complexity_score: score, complexity_level: cl.level,
    tshirt_size: cl.tshirt, effort_days: cl.effort, readiness: 'Partial',
    raw_metadata: { source: 'fallback', fileSize: size, dataSource: 'file_upload' }
  }];
}

module.exports = { parseAndPersist, deepParse };
