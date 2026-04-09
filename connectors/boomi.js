/**
 * Boomi AtomSphere Connector — Sprint 4 Deep Enablement
 *
 * MOCK MODE (default): Reads from mock/boomi/process-bank.json
 *
 * REAL MODE: Activates when BOOMI_ACCOUNT_ID + BOOMI_USERNAME + BOOMI_TOKEN are set.
 *   Auth:  Basic  base64("BOOMI_{accountId}@{username}:{apiToken}")
 *   Calls:
 *     POST /Process/query       — paginated list of all non-deleted processes
 *     POST /Process/queryMore   — next page via queryToken
 *     GET  /Component/{id}      — component XML with shapes, connectors, maps, scripts
 *     GET  /Atom                — list deployed atoms (connection test)
 *
 * Zero code changes needed to switch modes — set env vars and restart.
 */

'use strict';

const path   = require('path');
const xml2js = require('xml2js');
const fetch  = require('node-fetch');
const BANK   = require(path.join(__dirname, '../mock/boomi/process-bank.json'));

const BOOMI_BASE         = process.env.BOOMI_API_BASE || 'https://api.boomi.com/api/rest/v1';
const PAGE_SIZE          = 100;
const COMPONENT_BATCH    = 5;   // parallel component fetches

class BoomiConnector {
  constructor() {
    this.accountId = process.env.BOOMI_ACCOUNT_ID;
    this.username  = process.env.BOOMI_USERNAME;
    this.token     = process.env.BOOMI_TOKEN;
    this.mode      = (this.accountId && this.username && this.token) ? 'real' : 'mock';
    this.baseUrl   = `${BOOMI_BASE}/${this.accountId}`;
  }

  getMode() { return this.mode; }

  // ── Auth header ────────────────────────────────────────────────────────────
  _authHeader() {
    // Boomi Basic Auth: BOOMI_{accountId}@{username}:{apiToken}
    const raw = `BOOMI_${this.accountId}@${this.username}:${this.token}`;
    return `Basic ${Buffer.from(raw).toString('base64')}`;
  }

  // ── Public: get enriched data for one artifact ─────────────────────────────
  async getArtifactData(artifact) {
    if (this.mode === 'real') return this._realGetProcess(artifact.process_id, artifact);
    return this._mockGetProcess(artifact);
  }

  // ── Public: sync all processes from source (used by /sources/:id/sync) ─────
  async syncAllProcesses() {
    if (this.mode === 'real') return this._realSyncAll();
    return { artifacts: this._mockAllArtifacts(), dataSource: 'mock', processCount: Object.keys(BANK).length };
  }

  // ── Public: test connection validity ──────────────────────────────────────
  async testConnection(config) {
    if (this.mode === 'real') return this._realTestConnection(config);
    return { success: true, mode: 'mock', message: 'Mock mode — set BOOMI_ACCOUNT_ID, BOOMI_USERNAME, BOOMI_TOKEN to connect live', accountId: 'mock' };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // REAL API IMPLEMENTATION
  // ════════════════════════════════════════════════════════════════════════════

  async _realSyncAll() {
    const errors    = [];
    const processes = await this._listAllProcesses();

    if (!processes.length) {
      return { artifacts: this._mockAllArtifacts(), dataSource: 'mock_empty', processCount: 0 };
    }

    // Fetch component XML in small parallel batches
    const artifacts = [];
    for (let i = 0; i < processes.length; i += COMPONENT_BATCH) {
      const batch   = processes.slice(i, i + COMPONENT_BATCH);
      const results = await Promise.allSettled(
        batch.map(p => this._fetchComponent(p))
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) artifacts.push(r.value);
        else errors.push(r.reason?.message || 'Component fetch failed');
      }
    }

    return {
      artifacts: artifacts.length ? artifacts : this._mockAllArtifacts(),
      dataSource: artifacts.length ? 'live_api' : 'mock_fallback',
      processCount: processes.length,
      errors
    };
  }

  async _listAllProcesses() {
    const processes  = [];
    let queryToken   = null;
    let page         = 0;

    do {
      const url  = queryToken ? `${this.baseUrl}/Process/queryMore` : `${this.baseUrl}/Process/query`;
      const body = queryToken
        ? JSON.stringify(queryToken)
        : JSON.stringify({
            QueryFilter: {
              expression: {
                operator: 'and',
                nestedExpression: [
                  { property: 'deleted', operator: 'EQUALS', argument: ['false'] },
                  { property: 'type',    operator: 'EQUALS', argument: ['process'] }
                ]
              }
            }
          });

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': this._authHeader(), 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body,
        timeout: 15000
      });

      if (!resp.ok) throw new Error(`Process/query HTTP ${resp.status}: ${await resp.text()}`);

      const data  = await resp.json();
      const batch = data.result || [];
      processes.push(...batch);

      queryToken = (batch.length >= PAGE_SIZE && data.queryToken) ? data.queryToken : null;
      if (++page > 20) break; // safety cap — 2000 processes max
    } while (queryToken);

    return processes;
  }

  async _fetchComponent(processMeta) {
    const resp = await fetch(`${this.baseUrl}/Component/${processMeta.componentId}`, {
      headers: { 'Authorization': this._authHeader(), 'Accept': 'application/xml' },
      timeout: 10000
    });

    if (!resp.ok) {
      // Fall back to name-based estimate rather than failing
      return this._estimateFromMeta(processMeta);
    }

    const xml = await resp.text();
    return this._parseComponentXml(xml, processMeta);
  }

  async _parseComponentXml(xml, meta) {
    try {
      const parser = new xml2js.Parser({ explicitArray: true, ignoreAttrs: false });
      const doc    = await parser.parseStringPromise(xml);

      const comp    = doc['bns:Component'] || doc['Component'] || {};
      const obj     = (comp['bns:object']   || comp['object']   || [{}])[0];
      const procEl  = (obj['bns:process']   || obj['process']   || [{}])[0];

      const shapesEl  = (procEl['bns:shapes']       || procEl['shapes']       || [{}])[0];
      const connsEl   = (procEl['bns:connectors']    || procEl['connectors']   || [{}])[0];
      const mapsEl    = (procEl['bns:maps']          || procEl['maps']         || [{}])[0];
      const scriptsEl = (procEl['bns:scripts']       || procEl['scripts']      || [{}])[0];
      const errEl     = (procEl['bns:errorHandling'] || procEl['errorHandling']|| [{}])[0];
      const depsEl    = (procEl['bns:dependencies']  || procEl['dependencies'] || [{}])[0];
      const trigEl    = (procEl['bns:trigger']       || procEl['trigger']      || [{}])[0];

      const shapesCount     = parseInt((shapesEl['$']  || {}).count || 0);
      const connectorsCount = parseInt((connsEl['$']   || {}).count || 0);
      const mapsCount       = parseInt((mapsEl['$']    || {}).count || 0);
      const scriptsCount    = parseInt((scriptsEl['$'] || {}).count || 0);
      const depsCount       = parseInt((depsEl['$']    || {}).count || 0);
      const totalLines      = parseInt((scriptsEl['$'] || {}).totalLines || 0);
      const errorType       = (errEl['$'] || {}).type  || 'basic';
      const triggerType     = (trigEl['$'] || {}).type || 'API';

      const connList  = connsEl['bns:connector'] || connsEl['connector'] || [];
      const connTypes = connList.map(c => (c['$'] || {}).type || 'HTTP');
      const primaryConn = connTypes[0] || _detectConnectorFromName(meta.name || '');

      const domain       = _inferDomain(meta.name || '', meta.folderFullPath || '');
      const scriptLevel  = scriptsCount === 0 ? 0 : totalLines > 150 ? 3 : totalLines > 50 ? 2 : 1;
      const errLevel     = { none: 0, basic: 1, try_catch: 2, multi_try_catch: 3 }[errorType] ?? 1;
      const mapsComplex  = mapsCount === 0 ? 0 : mapsCount === 1 ? 1 : mapsCount <= 3 ? 2 : mapsCount <= 5 ? 3 : 4;

      const { computeComplexityScore, classifyComplexity } = require('../parsers/boomi');
      const score = computeComplexityScore({ shapes_count: shapesCount, connectors_count: connectorsCount, maps_complexity: mapsComplex, scripting_level: scriptLevel, error_handling_level: errLevel, dependencies_count: depsCount });
      const cl    = classifyComplexity(score);

      return {
        process_id:        meta.componentId,
        name:              meta.name || 'Unknown Process',
        domain,
        platform:          'boomi',
        artifact_type:     'Process',
        trigger_type:      triggerType,
        shapes_count:      shapesCount,
        connectors_count:  connectorsCount,
        maps_count:        mapsCount,
        has_scripting:     scriptsCount > 0,
        scripting_detail:  scriptsCount > 0 ? `${scriptsCount} Groovy script(s), ~${totalLines} lines` : null,
        error_handling:    errorType,
        dependencies_count: depsCount,
        primary_connector:  primaryConn,
        complexity_score:   score,
        complexity_level:   cl.level,
        tshirt_size:        cl.tshirt,
        effort_days:        cl.effort,
        readiness: scriptsCount > 1 ? 'Manual' : score > 55 ? 'Partial' : 'Auto',
        raw_metadata: { componentId: meta.componentId, folderPath: meta.folderFullPath, connectorTypes: connTypes, dataSource: 'live_api' }
      };
    } catch (e) {
      return this._estimateFromMeta(meta);
    }
  }

  _estimateFromMeta(meta) {
    const name  = meta.name || 'Unknown';
    const score = _estimateScore(name);
    const { classifyComplexity } = require('../parsers/boomi');
    const cl    = classifyComplexity(score);
    return {
      process_id: meta.componentId, name, domain: _inferDomain(name, ''), platform: 'boomi',
      artifact_type: 'Process', trigger_type: _inferTrigger(name),
      shapes_count: Math.floor(score / 4) + 5, connectors_count: score > 60 ? 3 : 2,
      maps_count: score > 50 ? 2 : 1, has_scripting: score > 65, scripting_detail: score > 65 ? 'Scripting estimated' : null,
      error_handling: score > 60 ? 'try_catch' : 'basic', dependencies_count: score > 70 ? 2 : 1,
      primary_connector: _detectConnectorFromName(name),
      complexity_score: score, complexity_level: cl.level, tshirt_size: cl.tshirt, effort_days: cl.effort,
      readiness: score > 65 ? 'Manual' : score > 45 ? 'Partial' : 'Auto',
      raw_metadata: { componentId: meta.componentId, dataSource: 'live_api_estimated' }
    };
  }

  async _realGetProcess(processId, artifact) {
    try {
      const resp = await fetch(`${this.baseUrl}/Component/${processId}`, {
        headers: { 'Authorization': this._authHeader(), 'Accept': 'application/xml' },
        timeout: 10000
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const xml = await resp.text();
      return await this._parseComponentXml(xml, { componentId: processId, name: artifact.name, folderFullPath: '' });
    } catch (e) {
      console.warn(`[Boomi] Component fetch failed for ${processId}:`, e.message);
      return this._mockGetProcess(artifact);
    }
  }

  async _realTestConnection(config) {
    const acct  = config?.accountId || this.accountId;
    const user  = config?.username  || this.username;
    const token = config?.token     || this.token;
    const auth  = `Basic ${Buffer.from(`BOOMI_${acct}@${user}:${token}`).toString('base64')}`;
    try {
      const resp = await fetch(`${BOOMI_BASE}/${acct}/Atom`, {
        headers: { 'Authorization': auth, 'Accept': 'application/json' },
        timeout: 8000
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      const data  = await resp.json();
      const atoms = (data.result || []).map(a => a.name || a['@name'] || 'Atom');
      return { success: true, mode: 'real', accountId: acct, atoms, atomCount: atoms.length };
    } catch (e) {
      return { success: false, mode: 'real', error: e.message };
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MOCK IMPLEMENTATION
  // ════════════════════════════════════════════════════════════════════════════

  _mockGetProcess(artifact) {
    if (BANK[artifact.name]) return { ...BANK[artifact.name], _source: 'mock', _mode: 'mock' };
    return this._generateFromMetadata(artifact);
  }

  _mockAllArtifacts() {
    return Object.keys(BANK).map((name, i) => {
      const entry = BANK[name];
      const { classifyComplexity } = require('../parsers/boomi');
      const score = 35 + (i % 5) * 12;
      const cl    = classifyComplexity(score);
      return {
        process_id: entry.platformId || `mock-${i}`, name, domain: 'INT', platform: 'boomi',
        artifact_type: 'Process', trigger_type: 'API',
        shapes_count: 15, connectors_count: 2, maps_count: 2, has_scripting: false,
        scripting_detail: null, error_handling: 'basic', dependencies_count: 1,
        primary_connector: 'HTTP', complexity_score: score,
        complexity_level: cl.level, tshirt_size: cl.tshirt, effort_days: cl.effort,
        readiness: 'Partial', raw_metadata: { dataSource: 'mock' }
      };
    });
  }

  _generateFromMetadata(artifact) {
    const primary = artifact.primary_connector || 'HTTP/REST';
    const shapes  = [];
    const trigConn = { Schedule: 'Timer', API: 'HTTP Server', Event: 'JMS', Listener: primary }[artifact.trigger_type] || 'HTTP';
    shapes.push({ type: 'start',     label: `${trigConn} Start`,               connector: trigConn });
    shapes.push({ type: 'connector', label: `${primary} Operation`,             connector: primary, operation: 'Execute' });
    for (let i = 0; i < Math.min(artifact.maps_count || 1, 3); i++)
      shapes.push({ type: 'map', label: `Data Transformation ${i + 1}`, sourceFormat: 'XML', targetFormat: 'JSON' });
    if (artifact.error_handling !== 'none')
      shapes.push({ type: 'decision', label: 'Operation Successful?' });
    if (artifact.has_scripting)
      shapes.push({ type: 'connector', label: 'Custom Script Processing', connector: 'Groovy', operation: 'script' });
    shapes.push({ type: 'stop', label: 'End Process' });

    return {
      platformId: artifact.process_id || `boomi-${artifact.name}`,
      folder: `/Production/${artifact.domain || 'INT'} Integration`,
      description: `${artifact.name.replace(/_/g, ' ')} — Boomi integration process`,
      deployedTo: ['Production Atom - US East'], lastModified: new Date(Date.now() - 86400000 * 7).toISOString(),
      shapes, connectorTypes: [primary, 'Database'],
      mapDescriptions: Array.from({ length: artifact.maps_count || 1 }, (_, i) => `Data Mapping ${i + 1}`),
      scripts: artifact.has_scripting ? [{ language: 'Groovy', name: `${artifact.name}_Script`, purpose: artifact.scripting_detail || 'Custom logic' }] : [],
      errorHandling: { type: artifact.error_handling, hasRetry: artifact.error_handling !== 'none', retryAttempts: artifact.error_handling === 'multi_try_catch' ? 3 : 1 },
      dependencies: Array.from({ length: artifact.dependencies_count || 1 }, (_, i) => `Dependency_${i + 1}`),
      iflowAdapters: this._inferIFlowAdapters(artifact),
      _source: 'generated', _mode: 'mock'
    };
  }

  _inferIFlowAdapters(artifact) {
    const adapterMap = {
      'Salesforce': 'Salesforce Receiver Adapter', 'SAP S/4HANA': 'OData Receiver (SAP S/4HANA)',
      'SAP SuccessFactors': 'SuccessFactors Adapter', 'SFTP': 'SFTP Adapter', 'AS2': 'AS2 Receiver Adapter',
      'JMS': 'JMS Adapter', 'Kafka': 'Kafka Adapter', 'HTTP/REST': 'HTTPS Receiver Adapter',
      'IDoc': 'IDoc Receiver Adapter', 'RFC': 'RFC Receiver Adapter',
      'JDBC': 'JDBC Adapter', 'SAP Ariba': 'Ariba Receiver Adapter', 'SMTP': 'Mail Adapter'
    };
    const triggerMap = { Schedule: 'Timer Start Event', API: 'HTTPS Sender Adapter', Event: 'JMS Sender Adapter', Listener: 'SFTP Sender Adapter' };
    return [
      triggerMap[artifact.trigger_type] || 'HTTPS Sender Adapter',
      adapterMap[artifact.primary_connector] || 'HTTPS Receiver Adapter',
      'JDBC Adapter'
    ].filter((v, i, a) => a.indexOf(v) === i);
  }

  // ── listProcesses (used by iflow download) ─────────────────────────────────
  async listProcesses() {
    if (this.mode === 'real') {
      try {
        const list = await this._listAllProcesses();
        return list.map(p => ({ id: p.componentId, name: p.name, folder: p.folderFullPath }));
      } catch (e) {
        console.warn('[Boomi] listProcesses API failed:', e.message);
      }
    }
    return Object.keys(BANK).map(name => ({ id: BANK[name].platformId, name, folder: BANK[name].folder }));
  }
}

// ── Helpers (module-level, shared) ────────────────────────────────────────────
function _inferDomain(name, folder) {
  const t = (name + ' ' + folder).toLowerCase();
  if (/customer|crm|sales|order|account/.test(t))              return 'CRM';
  if (/invoice|payment|financ|gl |journal|billing|revenue/.test(t)) return 'FIN';
  if (/employee|hr |payroll|leave|workforce|onboard/.test(t))  return 'HR';
  if (/inventory|supply|warehouse|material|stock|po |purchase/.test(t)) return 'SCM';
  if (/edi|as2|b2b|vendor|supplier/.test(t))                   return 'EXT';
  if (/drill|well|rig|mud|subsurface|reservoir/.test(t))       return 'Drilling';
  if (/field.serv|dispatch|technician|work.order/.test(t))     return 'Field Services';
  if (/asset|equip|maintenance|mttr|certif/.test(t))           return 'Assets';
  if (/hse|safety|incident|emergency/.test(t))                 return 'HSE';
  return 'INT';
}

function _inferTrigger(name) {
  const n = name.toLowerCase();
  if (/inbound|listener|receive/.test(n)) return 'Listener';
  if (/schedule|batch|daily|weekly|sync/.test(n)) return 'Schedule';
  if (/event|notify|alert/.test(n)) return 'Event';
  return 'API';
}

function _detectConnectorFromName(name) {
  const n = name.toLowerCase();
  if (/salesforce|sfdc/.test(n))           return 'Salesforce';
  if (/ariba/.test(n))                     return 'SAP Ariba';
  if (/successfactor|sf_sap|sap_sf/.test(n)) return 'SAP SuccessFactors';
  if (/s4hana|s\/4|sap_pm|sap/.test(n))   return 'SAP S/4HANA';
  if (/sftp|ftp/.test(n))                  return 'SFTP';
  if (/as2|edi/.test(n))                   return 'AS2';
  if (/jms|queue/.test(n))                 return 'JMS';
  if (/kafka/.test(n))                     return 'Kafka';
  if (/jdbc|database|db/.test(n))          return 'JDBC';
  if (/smtp|mail|email/.test(n))           return 'SMTP';
  return 'HTTP/REST';
}

function _estimateScore(name) {
  const n = name.toLowerCase();
  let s = 30;
  if (/edi|as2|b2b/.test(n))           s += 30;
  if (/recon|batch|reconcil/.test(n))  s += 20;
  if (/payroll|settlement/.test(n))    s += 20;
  if (/master|dist/.test(n))           s -= 10;
  if (/status|update|notify/.test(n))  s -= 10;
  if (/alert/.test(n))                 s -= 15;
  return Math.min(95, Math.max(10, s));
}

module.exports = BoomiConnector;
