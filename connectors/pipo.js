/**
 * SAP PI/PO (PIPO) Connector
 *
 * MOCK MODE (default): Reads from mock/pipo/scenario-bank.json
 *
 * REAL MODE: File-based — no live PIPO API exists.
 *   Activates when a real XI export ZIP is uploaded via POST /api/sources/upload.
 *   The existing pipo.js parser handles the XML extraction.
 *   Real data flows in via file upload, same code path as mock.
 *
 * To test with real data: Upload actual SAP PI/PO XI export ZIP via the Sources page.
 *   The parser (/parsers/pipo.js) extracts artifacts → same engine runs on them.
 */

const path = require('path');
const BANK = require(path.join(__dirname, '../mock/pipo/scenario-bank.json'));

class PIPOConnector {
  constructor() {
    this.mode = 'mock'; // PIPO is always file-based; no live REST API
  }

  getMode() { return 'mock (file-based — upload XI export to use real data)'; }

  async getArtifactData(artifact) {
    return this._mockGetScenario(artifact);
  }

  async listScenarios() {
    return Object.values(BANK).map(s => ({
      id: s.platformId, name: s.scenarioName,
      senderSystem: s.senderSystem, receiverSystem: s.receiverSystem,
      description: s.description, lastModified: s.lastModified
    }));
  }

  async testConnection() {
    return { success: true, mode: 'file-based', message: 'PIPO uses file upload — upload XI export ZIP via Sources page to import real scenarios' };
  }

  // ── Mock Implementation ──────────────────────────────────────────────────

  _mockGetScenario(artifact) {
    if (BANK[artifact.name]) return { ...BANK[artifact.name], _source: 'mock', _mode: 'mock' };
    return this._generateFromMetadata(artifact);
  }

  _generateFromMetadata(artifact) {
    const channelTypeMap = {
      'IDoc': { sender: { type: 'IDoc', direction: 'Outbound' }, receiver: { type: 'HTTP', direction: 'Inbound' } },
      'RFC': { sender: { type: 'RFC', direction: 'Outbound' }, receiver: { type: 'HTTP', direction: 'Inbound' } },
      'HTTP/REST': { sender: { type: 'HTTP', direction: 'Inbound' }, receiver: { type: 'RFC', direction: 'Outbound' } },
      'AS2': { sender: { type: 'IDoc', direction: 'Outbound' }, receiver: { type: 'AS2', direction: 'Outbound' } },
      'SFTP': { sender: { type: 'JDBC', direction: 'Outbound' }, receiver: { type: 'SFTP', direction: 'Outbound' } },
      'JDBC': { sender: { type: 'JDBC', direction: 'Outbound' }, receiver: { type: 'SFTP', direction: 'Outbound' } }
    };
    const channel = channelTypeMap[artifact.primary_connector] || channelTypeMap['HTTP/REST'];

    const scripts = artifact.has_scripting ? [
      { language: 'Java', name: `${artifact.name}_Script`, purpose: 'Custom mapping or validation logic' }
    ] : [];

    return {
      platformId: artifact.process_id || `pipo-${artifact.name}`,
      scenarioName: artifact.name,
      softwareComponent: 'LOGISTICS_ECC',
      namespace: `urn:acme-logistics:${artifact.domain?.toLowerCase() || 'int'}`,
      description: `${artifact.name.replace(/_/g, ' ')} — SAP PI/PO integration scenario`,
      senderSystem: 'ERP_PRD',
      receiverSystem: 'TARGET_SYSTEM',
      channel,
      messageInterface: { name: `${artifact.name}_Interface`, namespace: 'urn:sap.com:xi:SAP_BS_FND_IDOC:Global' },
      mapping: { name: `${artifact.name}_Mapping`, type: artifact.maps_count > 2 ? 'XSLT' : 'Message Mapping', sourceMessage: 'Source_Message', targetMessage: 'Target_Message' },
      mappingFields: (artifact.maps_count || 1) * 18,
      operationMapping: { name: `OM_${artifact.name}`, messageMapping: `${artifact.name}_Mapping` },
      scripts,
      errorHandling: { type: artifact.error_handling, alertChannel: 'Email', retryEnabled: artifact.error_handling !== 'none', retryAttempts: 2 },
      dependencies: Array.from({ length: artifact.dependencies_count || 1 }, (_, i) => `Dependency_${i + 1}`),
      iflowAdapters: this._inferIFlowAdapters(artifact),
      _source: 'generated', _mode: 'mock'
    };
  }

  _inferIFlowAdapters(artifact) {
    const adapterMap = {
      'IDoc': ['IDoc Sender Adapter', 'HTTP Receiver Adapter'],
      'RFC': ['RFC Sender Adapter', 'HTTP Receiver Adapter'],
      'AS2': ['IDoc Sender Adapter', 'AS2 Receiver Adapter'],
      'SFTP': ['JDBC Adapter', 'SFTP Receiver Adapter'],
      'HTTP/REST': ['HTTP Sender Adapter', 'RFC Receiver Adapter'],
      'JDBC': ['JDBC Adapter', 'SFTP Receiver Adapter']
    };
    return adapterMap[artifact.primary_connector] || ['HTTP Sender Adapter', 'HTTP Receiver Adapter'];
  }
}

module.exports = PIPOConnector;
