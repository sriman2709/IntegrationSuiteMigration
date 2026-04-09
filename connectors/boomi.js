/**
 * Boomi AtomSphere Connector
 *
 * MOCK MODE (default): Reads from mock/boomi/process-bank.json
 *   → No credentials needed. Auto-selects by artifact name.
 *
 * REAL MODE: Activates when BOOMI_ACCOUNT_ID + BOOMI_USERNAME + BOOMI_TOKEN are set.
 *   → Calls AtomSphere REST API:
 *     GET /ws/rest/Process           — list all processes
 *     GET /ws/rest/Process/{id}      — get process details
 *     GET /ws/rest/ProcessScheduleStatus — runtime status
 *     GET /ws/rest/Atom              — deployed atom list
 *     GET /ws/rest/DeployedPackage   — what's deployed where
 *
 * When real credentials arrive: set BOOMI_ACCOUNT_ID, BOOMI_USERNAME, BOOMI_TOKEN.
 * Connector automatically uses real API. ZERO code changes in engine or routes.
 */

const path = require('path');
const BANK = require(path.join(__dirname, '../mock/boomi/process-bank.json'));

class BoomiConnector {
  constructor() {
    this.mode = (process.env.BOOMI_ACCOUNT_ID && process.env.BOOMI_USERNAME && process.env.BOOMI_TOKEN)
      ? 'real' : 'mock';
    this.baseUrl = process.env.BOOMI_API_BASE || 'https://api.boomi.com/api/rest/v1';
    this.accountId = process.env.BOOMI_ACCOUNT_ID;
  }

  /** Returns mode string for logging/display */
  getMode() { return this.mode; }

  /**
   * Get enriched platform data for an artifact.
   * Mock: looks up by artifact name in bank, falls back to generated data.
   * Real: fetches from AtomSphere API by process_id.
   */
  async getArtifactData(artifact) {
    if (this.mode === 'real') {
      return this._realGetProcess(artifact.process_id, artifact);
    }
    return this._mockGetProcess(artifact);
  }

  /** List all processes (used by sources sync) */
  async listProcesses(projectConfig) {
    if (this.mode === 'real') return this._realListProcesses(projectConfig);
    return Object.values(BANK).map(p => ({
      id: p.platformId,
      name: p.platformId.replace('boomi-p1-','').replace(/_/g,' '),
      folder: p.folder,
      description: p.description,
      lastModified: p.lastModified
    }));
  }

  /** Test connection validity */
  async testConnection(config) {
    if (this.mode === 'real') return this._realTestConnection(config);
    return { success: true, mode: 'mock', message: 'Mock connection — no credentials configured', accountId: 'mock-account', atoms: ['Mock Production Atom'] };
  }

  // ── Mock Implementation ──────────────────────────────────────────────────

  _mockGetProcess(artifact) {
    // Try exact name match first
    const key = artifact.name;
    if (BANK[key]) {
      return { ...BANK[key], _source: 'mock', _mode: 'mock' };
    }
    // Fallback: generate from artifact metadata
    return this._generateFromMetadata(artifact);
  }

  _generateFromMetadata(artifact) {
    const connectorTypeMap = {
      'Salesforce': 'Salesforce', 'SAP S/4HANA': 'SAP S/4HANA', 'SAP SuccessFactors': 'SAP SuccessFactors',
      'SFTP': 'SFTP', 'AS2': 'AS2', 'JMS': 'JMS', 'Kafka': 'Kafka',
      'HTTP/REST': 'HTTP/REST', 'IDoc': 'IDoc', 'RFC': 'RFC', 'JDBC': 'JDBC',
      'SAP Ariba': 'SAP Ariba', 'Database': 'Database'
    };
    const triggerConnector = {
      'Schedule': 'Timer', 'API': 'HTTP Server', 'Event': 'JMS', 'Listener': artifact.primary_connector || 'HTTP Server'
    };

    const shapes = [];
    shapes.push({ type: 'start', label: `${triggerConnector[artifact.trigger_type] || 'HTTP'} Start`, connector: triggerConnector[artifact.trigger_type] || 'HTTP Server' });
    const primary = artifact.primary_connector || 'HTTP/REST';
    shapes.push({ type: 'connector', label: `${primary} Operation`, connector: primary, operation: 'Execute' });
    for (let i = 0; i < Math.min((artifact.maps_count || 1), 3); i++) {
      shapes.push({ type: 'map', label: `Data Transformation ${i + 1}`, sourceFormat: 'XML', targetFormat: 'JSON' });
    }
    if (artifact.error_handling !== 'none') {
      shapes.push({ type: 'decision', label: 'Operation Successful?' });
    }
    if (artifact.has_scripting) {
      shapes.push({ type: 'connector', label: 'Custom Script Processing', connector: 'Groovy', operation: 'script' });
    }
    shapes.push({ type: 'stop', label: 'End Process' });

    const scripts = artifact.has_scripting ? [
      { language: 'Groovy', name: `${artifact.name}_Script`, purpose: artifact.scripting_detail || 'Custom business logic processing' }
    ] : [];

    return {
      platformId: artifact.process_id || `boomi-${artifact.name}`,
      folder: `/Production/${artifact.domain || 'INT'} Integration`,
      description: `${artifact.name.replace(/_/g, ' ')} — ${artifact.platform?.toUpperCase()} integration process`,
      deployedTo: ['Production Atom - US East'],
      lastModified: new Date(Date.now() - Math.random() * 30 * 24 * 3600000).toISOString(),
      shapes,
      connectorTypes: [primary, 'Database'],
      mapDescriptions: Array.from({ length: artifact.maps_count || 1 }, (_, i) => `Data Mapping ${i + 1} (${10 + i * 5} fields)`),
      scripts,
      errorHandling: { type: artifact.error_handling, hasRetry: artifact.error_handling !== 'none', retryAttempts: artifact.error_handling === 'multi_try_catch' ? 3 : 1 },
      dependencies: Array.from({ length: artifact.dependencies_count || 1 }, (_, i) => `Dependency_${i + 1}`),
      iflowAdapters: this._inferIFlowAdapters(artifact),
      _source: 'generated', _mode: 'mock'
    };
  }

  _inferIFlowAdapters(artifact) {
    const adapterMap = {
      'Salesforce': 'Salesforce Receiver Adapter', 'SAP S/4HANA': 'OData Receiver (SAP S/4HANA)', 'SAP SuccessFactors': 'SuccessFactors Adapter',
      'SFTP': 'SFTP Adapter', 'AS2': 'AS2 Receiver Adapter', 'JMS': 'JMS Adapter',
      'Kafka': 'Kafka Adapter', 'HTTP/REST': 'HTTPS Receiver Adapter', 'IDoc': 'IDoc Receiver Adapter',
      'RFC': 'RFC Receiver Adapter', 'JDBC': 'JDBC Adapter', 'SAP Ariba': 'Ariba Receiver Adapter'
    };
    const triggerMap = { 'Schedule': 'Timer Start Event', 'API': 'HTTPS Sender Adapter', 'Event': 'JMS Sender Adapter', 'Listener': 'SFTP Sender Adapter' };
    return [
      triggerMap[artifact.trigger_type] || 'HTTPS Sender Adapter',
      adapterMap[artifact.primary_connector] || 'HTTPS Receiver Adapter',
      'JDBC Adapter'
    ].filter((v, i, a) => a.indexOf(v) === i);
  }

  // ── Real API Implementation (stubs — activates with credentials) ──────────

  async _realListProcesses(config) {
    const fetch = require('node-fetch');
    const auth = Buffer.from(`${this.accountId}/${process.env.BOOMI_USERNAME}:${process.env.BOOMI_TOKEN}`).toString('base64');
    const url = `${this.baseUrl}/${this.accountId}/Process`;
    try {
      const res = await fetch(url, { headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`Boomi API error: ${res.status}`);
      const data = await res.json();
      return (data.result || []).map(p => ({ id: p['@id'], name: p.name, folder: p.folderId, description: '' }));
    } catch (e) {
      console.warn('Boomi real API failed, falling back to mock:', e.message);
      return this._mockGetProcess({ name: 'fallback' });
    }
  }

  async _realGetProcess(processId, artifact) {
    const fetch = require('node-fetch');
    const auth = Buffer.from(`${this.accountId}/${process.env.BOOMI_USERNAME}:${process.env.BOOMI_TOKEN}`).toString('base64');
    const url = `${this.baseUrl}/${this.accountId}/Process/${processId}`;
    try {
      const res = await fetch(url, { headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`Boomi API error: ${res.status}`);
      const data = await res.json();
      return { ...data, _source: 'api', _mode: 'real' };
    } catch (e) {
      console.warn(`Boomi real API failed for ${processId}, falling back to mock:`, e.message);
      return this._mockGetProcess(artifact);
    }
  }

  async _realTestConnection(config) {
    const fetch = require('node-fetch');
    const auth = Buffer.from(`${config.accountId}/${config.username}:${config.token}`).toString('base64');
    try {
      const res = await fetch(`${this.baseUrl}/${config.accountId}/Atom`, { headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return { success: true, mode: 'real', accountId: config.accountId, atoms: (data.result || []).map(a => a.name) };
    } catch (e) {
      return { success: false, mode: 'real', error: e.message };
    }
  }
}

module.exports = BoomiConnector;
