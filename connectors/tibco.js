/**
 * TIBCO BusinessWorks Connector
 *
 * MOCK MODE (default): Reads from mock/tibco/process-bank.json
 *
 * REAL MODE: File-based — TIBCO BW has no public REST API.
 *   Activates when a real TIBCO BW project ZIP is uploaded via POST /api/sources/upload.
 *   The existing tibco.js parser handles XML extraction from .process files.
 *   Real data flows in via file upload — same engine runs on real or mock data.
 *
 * To test with real data: Export TIBCO BW project as ZIP from Designer,
 *   upload via Sources page. Parser auto-detects BusinessWorksProject XML.
 */

const path = require('path');
const BANK = require(path.join(__dirname, '../mock/tibco/process-bank.json'));

class TIBCOConnector {
  constructor() {
    this.mode = 'mock'; // TIBCO is always file-based
  }

  getMode() { return 'mock (file-based — upload BW project ZIP to use real data)'; }

  async getArtifactData(artifact) {
    return this._mockGetProcess(artifact);
  }

  async listProcesses() {
    return Object.values(BANK).map(p => ({
      id: p.platformId, name: p.platformId.replace('tibco-p4-', '').replace(/_/g, ' '),
      projectPath: p.projectPath, description: p.description, runtime: p.runtime, lastModified: p.lastModified
    }));
  }

  async testConnection() {
    return { success: true, mode: 'file-based', message: 'TIBCO BW uses file upload — export BW 5.x project as ZIP and upload via Sources page' };
  }

  // ── Mock Implementation ──────────────────────────────────────────────────

  _mockGetProcess(artifact) {
    if (BANK[artifact.name]) return { ...BANK[artifact.name], _source: 'mock', _mode: 'mock' };
    return this._generateFromMetadata(artifact);
  }

  _generateFromMetadata(artifact) {
    const activityTypeMap = {
      'Schedule': 'Timer', 'API': 'Receive', 'Event': 'JMSReceive', 'Listener': 'FilePoller'
    };
    const startActivity = activityTypeMap[artifact.trigger_type] || 'Receive';

    const activities = [
      { type: startActivity, label: `${artifact.name} Start`, transport: artifact.trigger_type === 'API' ? 'HTTP' : undefined }
    ];

    if (artifact.maps_count > 0) {
      activities.push({ type: 'Mapper', label: 'Transform Input Data', xslt: artifact.maps_count > 2 });
    }

    const connMap = {
      'HTTP/REST': 'HTTPRequest', 'JDBC': 'JDBCQuery', 'JMS': 'JMSPublish',
      'SFTP': 'FileWrite', 'AS2': 'AS2Send', 'SMTP': 'SMTPSend'
    };
    const mainActivity = connMap[artifact.primary_connector] || 'HTTPRequest';
    activities.push({ type: mainActivity, label: `${artifact.primary_connector || 'HTTP'} Operation` });

    if (artifact.error_handling !== 'none') {
      activities.push({ type: 'FaultHandler', label: 'Error Handling' });
    }

    activities.push({ type: 'Reply', label: 'End Process' });

    const scripts = artifact.has_scripting ? [
      { language: 'Java', name: `${artifact.name}_Logic`, purpose: 'Custom business logic and data processing' }
    ] : [];

    const connectorTypes = [];
    if (['JMSReceive', 'JMSPublish'].includes(mainActivity)) connectorTypes.push('JMS');
    else if (['JDBCQuery', 'JDBCUpdate', 'JDBCInsert'].includes(mainActivity)) connectorTypes.push('JDBC');
    else if (mainActivity === 'HTTPRequest') connectorTypes.push('HTTP');
    else if (mainActivity === 'FilePoller' || mainActivity === 'FileWrite') connectorTypes.push('SFTP');
    else if (mainActivity === 'AS2Send') connectorTypes.push('AS2');
    else connectorTypes.push('HTTP');

    return {
      platformId: artifact.process_id || `tibco-${artifact.name}`,
      projectPath: `/RetailCo/${artifact.domain || 'INT'}/${artifact.name}`,
      description: `${artifact.name.replace(/_/g, ' ')} — TIBCO BusinessWorks 5.x process`,
      runtime: 'TIBCO BW 5.14',
      lastModified: new Date(Date.now() - Math.random() * 30 * 24 * 3600000).toISOString(),
      activities,
      sharedResources: Array.from({ length: artifact.connectors_count || 1 }, (_, i) => `SharedResource_${i + 1}`),
      connectorTypes,
      mappers: Array.from({ length: artifact.maps_count || 1 }, (_, i) => ({
        name: `Mapper_${i + 1}`, type: i === 0 && artifact.maps_count > 2 ? 'XSLT' : 'BW Mapper',
        fields: 10 + i * 8, hasCustomXPath: i === 0 && artifact.maps_count > 3
      })),
      scripts,
      errorHandling: { type: artifact.error_handling, hasTimeout: artifact.error_handling !== 'none', timeoutSeconds: 30, hasFaultHandler: artifact.error_handling !== 'none' },
      dependencies: Array.from({ length: artifact.dependencies_count || 1 }, (_, i) => `Library_${i + 1}.bwlib`),
      iflowAdapters: this._inferIFlowAdapters(artifact),
      _source: 'generated', _mode: 'mock'
    };
  }

  _inferIFlowAdapters(artifact) {
    const adapterMap = {
      'HTTP/REST': 'HTTPS Receiver Adapter', 'JDBC': 'JDBC Adapter', 'JMS': 'JMS Adapter',
      'SFTP': 'SFTP Adapter', 'AS2': 'AS2 Receiver Adapter', 'SMTP': 'Mail Adapter'
    };
    const triggerMap = {
      'Schedule': 'Timer Start Event', 'API': 'HTTPS Sender Adapter',
      'Event': 'JMS Sender Adapter', 'Listener': 'SFTP Sender Adapter'
    };
    return [
      triggerMap[artifact.trigger_type] || 'HTTPS Sender Adapter',
      adapterMap[artifact.primary_connector] || 'HTTPS Receiver Adapter',
      'JDBC Adapter'
    ].filter((v, i, a) => a.indexOf(v) === i);
  }
}

module.exports = TIBCOConnector;
