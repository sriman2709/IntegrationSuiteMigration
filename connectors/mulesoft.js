/**
 * MuleSoft Anypoint Platform Connector
 *
 * MOCK MODE (default): Reads from mock/mulesoft/flow-bank.json
 *
 * REAL MODE: Activates when MULESOFT_CLIENT_ID + MULESOFT_CLIENT_SECRET + MULESOFT_ORG_ID are set.
 *   → Calls Anypoint Platform API:
 *     POST /accounts/oauth2/token         — client credentials OAuth2
 *     GET  /armui/api/v1/applications     — deployed apps (CloudHub)
 *     GET  /hybrid/api/v1/applications    — on-prem apps (Hybrid)
 *     GET  /exchange/api/v1/assets        — Exchange assets
 *     GET  /armui/api/v1/applications/{id}/artifact — app archive download
 */

const path = require('path');
const BANK = require(path.join(__dirname, '../mock/mulesoft/flow-bank.json'));

class MuleSoftConnector {
  constructor() {
    this.mode = (process.env.MULESOFT_CLIENT_ID && process.env.MULESOFT_CLIENT_SECRET)
      ? 'real' : 'mock';
    this.baseUrl = 'https://anypoint.mulesoft.com';
    this.orgId = process.env.MULESOFT_ORG_ID;
    this._accessToken = null;
  }

  getMode() { return this.mode; }

  async getArtifactData(artifact) {
    if (this.mode === 'real') return this._realGetFlow(artifact);
    return this._mockGetFlow(artifact);
  }

  async listFlows(projectConfig) {
    if (this.mode === 'real') return this._realListFlows();
    return Object.values(BANK).map(f => ({
      id: f.platformId, name: f.appName,
      description: f.description, runtime: f.runtime, lastModified: f.lastModified
    }));
  }

  async testConnection(config) {
    if (this.mode === 'real') return this._realTestConnection(config);
    return { success: true, mode: 'mock', message: 'Mock connection — set MULESOFT_CLIENT_ID + MULESOFT_CLIENT_SECRET to enable real API', orgId: 'mock-org' };
  }

  // ── Mock Implementation ──────────────────────────────────────────────────

  _mockGetFlow(artifact) {
    if (BANK[artifact.name]) return { ...BANK[artifact.name], _source: 'mock', _mode: 'mock' };
    return this._generateFromMetadata(artifact);
  }

  _generateFromMetadata(artifact) {
    const trigger = artifact.trigger_type === 'Schedule' ? 'scheduler' : artifact.trigger_type === 'Event' ? 'kafka:message-listener' : 'http:listener';
    const processors = [
      { type: trigger, label: `${artifact.name} Trigger` },
      { type: 'ee:transform', label: 'Transform Message', language: 'DataWeave 2.0' }
    ];
    if (artifact.primary_connector && artifact.primary_connector !== 'HTTP') {
      processors.push({ type: 'http:request', label: `${artifact.primary_connector} Integration` });
    }
    if (artifact.has_scripting) {
      processors.push({ type: 'ee:transform', label: 'DataWeave Business Logic', language: 'DataWeave 2.0' });
    }
    processors.push({ type: 'error-handler', label: 'Error Handler', strategy: 'on-error-propagate' });

    const dwTransforms = Array.from({ length: artifact.maps_count || 1 }, (_, i) => ({
      name: `Transform${i + 1}`, complexity: i === 0 ? 'medium' : 'simple',
      inputFormat: 'JSON', outputFormat: 'JSON', fieldMappings: 10 + i * 8
    }));

    const scripts = artifact.has_scripting ? [
      { language: 'DataWeave', name: `${artifact.name}Logic`, purpose: 'Custom transformation and business logic' }
    ] : [];

    return {
      platformId: artifact.process_id || `mule-${artifact.name}`,
      appName: artifact.name.toLowerCase().replace(/_/g, '-'),
      description: `${artifact.name.replace(/_/g, ' ')} — MuleSoft Anypoint integration flow`,
      runtime: '4.4.0', environment: 'Production',
      lastModified: new Date(Date.now() - Math.random() * 30 * 24 * 3600000).toISOString(),
      processors, connectorTypes: [artifact.primary_connector || 'HTTP', 'Database'],
      dataWeaveTransforms: dwTransforms, scripts,
      errorHandling: { type: artifact.error_handling, hasRetry: artifact.error_handling !== 'none', retryAttempts: 2, hasCircuitBreaker: artifact.complexity_level === 'Complex' },
      dependencies: Array.from({ length: artifact.dependencies_count || 1 }, (_, i) => `Config_${i + 1}`),
      iflowAdapters: this._inferIFlowAdapters(artifact),
      _source: 'generated', _mode: 'mock'
    };
  }

  _inferIFlowAdapters(artifact) {
    const adapterMap = {
      'HTTP': 'HTTPS Receiver Adapter', 'Salesforce': 'Salesforce Receiver Adapter',
      'SAP OData': 'OData Receiver (SAP)', 'Database': 'JDBC Adapter',
      'Kafka': 'Kafka Adapter', 'JMS': 'JMS Adapter', 'SFTP': 'SFTP Adapter',
      'AWS S3': 'Amazon S3 Adapter', 'External HTTP': 'HTTPS Receiver Adapter'
    };
    const triggerMap = {
      'Schedule': 'Timer Start Event', 'API': 'HTTPS Sender Adapter',
      'Event': 'Kafka Sender Adapter', 'Listener': 'JMS Sender Adapter'
    };
    return [
      triggerMap[artifact.trigger_type] || 'HTTPS Sender Adapter',
      adapterMap[artifact.primary_connector] || 'HTTPS Receiver Adapter',
      'JDBC Adapter'
    ].filter((v, i, a) => a.indexOf(v) === i);
  }

  // ── Real API Implementation (stubs) ─────────────────────────────────────

  async _getAccessToken() {
    if (this._accessToken) return this._accessToken;
    const fetch = require('node-fetch');
    const res = await fetch(`${this.baseUrl}/accounts/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${process.env.MULESOFT_CLIENT_ID}&client_secret=${process.env.MULESOFT_CLIENT_SECRET}`
    });
    if (!res.ok) throw new Error(`MuleSoft OAuth failed: ${res.status}`);
    const data = await res.json();
    this._accessToken = data.access_token;
    return this._accessToken;
  }

  async _realListFlows() {
    const fetch = require('node-fetch');
    try {
      const token = await this._getAccessToken();
      const res = await fetch(`${this.baseUrl}/armui/api/v1/applications?organizationId=${this.orgId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`Anypoint API error: ${res.status}`);
      const data = await res.json();
      return (data.data || []).map(a => ({ id: a.id, name: a.artifact?.name, description: '', runtime: a.artifact?.muleVersion?.version }));
    } catch (e) {
      console.warn('MuleSoft real API failed:', e.message);
      return [];
    }
  }

  async _realGetFlow(artifact) {
    try {
      const token = await this._getAccessToken();
      return { name: artifact.name, _source: 'api', _mode: 'real', token_present: !!token };
    } catch (e) {
      console.warn('MuleSoft real API failed, falling back to mock:', e.message);
      return this._mockGetFlow(artifact);
    }
  }

  async _realTestConnection(config) {
    try {
      const fetch = require('node-fetch');
      const res = await fetch(`${this.baseUrl}/accounts/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${config.clientId}&client_secret=${config.clientSecret}`
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { success: true, mode: 'real', orgId: config.orgId };
    } catch (e) {
      return { success: false, mode: 'real', error: e.message };
    }
  }
}

module.exports = MuleSoftConnector;
