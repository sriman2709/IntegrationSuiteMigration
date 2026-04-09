/**
 * Deploy Engine
 * Simulates SAP Integration Suite deployment with realistic output.
 */

function runDeploy(artifact, platformData) {
  const iflowName = buildIFlowName(artifact);
  const iflowPackage = `${artifact.domain || 'INT'}_Migration_Package_v1`;
  const deployStart = new Date();
  const deployDuration = 12 + Math.floor(artifact.complexity_score / 10) + Math.floor(Math.random() * 8);

  const deployLog = buildDeployLog(artifact, platformData, iflowName, iflowPackage, deployStart, deployDuration);
  const validationChecks = buildDeployValidationChecks(artifact, platformData);
  const endpoint = buildEndpointInfo(artifact, iflowName);

  return {
    timestamp: deployStart.toISOString(),
    deployment: {
      iflow_id: iflowName,
      iflow_name: iflowName.replace(/_/g, ' '),
      package: iflowPackage,
      version: '1.0.0',
      tenant: process.env.CPI_TENANT_NAME || 'CPI-GlobalTech-Prod',
      tenant_url: process.env.CPI_TENANT_URL || 'https://cpi-prod.hana.ondemand.com',
      runtime: 'SAP Integration Suite — Cloud Integration',
      deploy_user: 'IS Migration Tool',
      duration_seconds: deployDuration,
      status: 'Success',
      deploy_start: deployStart.toISOString(),
      deploy_end: new Date(deployStart.getTime() + deployDuration * 1000).toISOString()
    },
    deploy_log: deployLog,
    validation_checks: validationChecks,
    execution_readiness: {
      status: 'Ready',
      endpoint: endpoint.url,
      endpoint_type: endpoint.type,
      authentication: endpoint.auth,
      message: `iFlow deployed and started. Runtime status: STARTED. Ready to accept ${artifact.trigger_type === 'API' ? 'HTTP requests' : artifact.trigger_type === 'Schedule' ? 'scheduled execution' : 'events'}.`
    },
    rollback_available: true,
    rollback_version: null
  };
}

function buildDeployLog(artifact, pd, iflowName, iflowPackage, startTime, durationSecs) {
  const lines = [];
  const ts = (offset) => new Date(startTime.getTime() + offset * 1000).toISOString().split('T')[1].split('.')[0];

  lines.push(`[${ts(0)}] === SAP Integration Suite Deployment Engine ===`);
  lines.push(`[${ts(0)}] Target Tenant : ${process.env.CPI_TENANT_NAME || 'CPI-GlobalTech-Prod'}`);
  lines.push(`[${ts(0)}] iFlow ID      : ${iflowName}`);
  lines.push(`[${ts(0)}] Package       : ${iflowPackage}`);
  lines.push(`[${ts(0)}] Version       : 1.0.0`);
  lines.push(`[${ts(0)}] Source        : ${artifact.platform?.toUpperCase()} Migration`);
  lines.push(`[${ts(1)}] `);
  lines.push(`[${ts(1)}] [1/6] Uploading Integration Package...`);
  lines.push(`[${ts(2)}]   ✓ Package ${iflowPackage} created/updated`);
  lines.push(`[${ts(2)}]   ✓ iFlow ${iflowName} artifact uploaded (${estimateArtifactSize(artifact)} KB)`);
  lines.push(`[${ts(3)}] `);
  lines.push(`[${ts(3)}] [2/6] Validating iFlow structure...`);
  lines.push(`[${ts(3)}]   ✓ BPMN2 schema validation: PASSED`);
  lines.push(`[${ts(4)}]   ✓ Adapter configuration validation: PASSED`);
  lines.push(`[${ts(4)}]   ✓ Externalized parameters: ${artifact.connectors_count + 2} parameters found`);
  lines.push(`[${ts(5)}]   ✓ Credential Store references: RESOLVED`);
  lines.push(`[${ts(5)}] `);
  lines.push(`[${ts(5)}] [3/6] Resolving dependencies...`);
  lines.push(`[${ts(6)}]   ✓ ${artifact.dependencies_count} shared resource(s) resolved`);
  lines.push(`[${ts(6)}]   ✓ Integration Package manifest updated`);
  lines.push(`[${ts(7)}]   ✓ iFlow dependency graph validated — no circular references`);
  lines.push(`[${ts(7)}] `);
  lines.push(`[${ts(7)}] [4/6] Deploying to IS Runtime...`);
  lines.push(`[${ts(8)}]   ✓ Deployment request submitted to IS Runtime Engine`);
  lines.push(`[${ts(9)}]   ✓ iFlow container initialized`);
  lines.push(`[${ts(10)}]   ✓ Adapter connections initialized: ${artifact.connectors_count} connection(s)`);
  lines.push(`[${ts(11)}]   ✓ Sender adapter endpoint registered: ${buildEndpointInfo(artifact, iflowName).url}`);
  lines.push(`[${ts(12)}] `);
  lines.push(`[${ts(12)}] [5/6] Starting iFlow runtime...`);
  lines.push(`[${ts(13)}]   ✓ IS Runtime Worker Node allocated`);
  lines.push(`[${ts(durationSecs - 4)}]   ✓ ${artifact.trigger_type === 'Schedule' ? 'Timer Start Event registered — next run scheduled' : artifact.trigger_type === 'Event' ? 'Event listener registered and subscribed' : 'HTTPS sender endpoint activated'}`);
  lines.push(`[${ts(durationSecs - 3)}]   ✓ Message Processing Log writer initialized`);
  lines.push(`[${ts(durationSecs - 2)}]   ✓ Exception Subprocess handler registered`);
  lines.push(`[${ts(durationSecs - 1)}] `);
  lines.push(`[${ts(durationSecs - 1)}] [6/6] Deployment verification...`);
  lines.push(`[${ts(durationSecs)}]   ✓ iFlow status: STARTED`);
  lines.push(`[${ts(durationSecs)}]   ✓ Health check: PASSED`);
  lines.push(`[${ts(durationSecs)}] `);
  lines.push(`[${ts(durationSecs)}] ✅ DEPLOYMENT SUCCESSFUL in ${durationSecs}s`);
  lines.push(`[${ts(durationSecs)}] iFlow ${iflowName} is running and ready to process messages.`);

  return lines.join('\n');
}

function buildDeployValidationChecks(artifact, pd) {
  const hasB2B = (pd.connectorTypes || []).some(c => ['AS2', 'IDoc'].includes(c));
  return [
    { name: 'iFlow BPMN Structure', status: 'pass', message: 'BPMN2 XML validated against IS schema' },
    { name: 'Adapter References', status: 'pass', message: `${artifact.connectors_count} adapter reference(s) resolved` },
    { name: 'Manifest Integrity', status: 'pass', message: 'Integration Package manifest checksums verified' },
    { name: 'Schema Binding', status: artifact.maps_count > 0 ? 'pass' : 'pass', message: artifact.maps_count > 0 ? `${artifact.maps_count} message mapping schema(s) bound` : 'No schema binding required' },
    { name: 'Credential Lookup', status: 'pass', message: 'Secure Store aliases resolved — credentials available' },
    { name: 'Runtime Health Check', status: 'pass', message: 'iFlow container started, health probe returned HTTP 200' },
    { name: 'B2B Partner Configuration', status: hasB2B ? 'warning' : 'pass', message: hasB2B ? 'AS2/IDoc partners configured — verify certificate validity dates' : 'Not applicable — no B2B adapters' },
    { name: 'Externalized Parameters', status: 'pass', message: `${artifact.connectors_count + 2} externalized parameter(s) — values set for target environment` }
  ];
}

function buildEndpointInfo(artifact, iflowName) {
  const base = `https://cpi-prod.hana.ondemand.com`;
  const path = iflowName.toLowerCase().replace(/_/g, '-');

  if (artifact.trigger_type === 'Schedule') {
    return { url: `${base}/itspaces/Operations/MonitoringUI#/iflows/${iflowName}`, type: 'Timer (Scheduled)', auth: 'N/A — internal trigger' };
  }
  if (artifact.trigger_type === 'Event') {
    return { url: `${base}/itspaces/Operations/MonitoringUI#/iflows/${iflowName}`, type: 'JMS/Kafka Event Listener', auth: 'JMS Connection credentials' };
  }
  if (artifact.trigger_type === 'Listener') {
    return { url: `${base}/itspaces/Operations/MonitoringUI#/iflows/${iflowName}`, type: 'SFTP/AS2 Listener', auth: 'SFTP key-based or AS2 partner certificate' };
  }
  return { url: `${base}/http/${path}`, type: 'HTTPS API Endpoint', auth: 'OAuth2 or Basic Auth (configure in IS Policy)' };
}

function buildIFlowName(artifact) {
  const parts = (artifact.name || 'Process').replace(/[^a-zA-Z0-9_]/g, '_').split('_').filter(Boolean);
  return `${artifact.domain || 'INT'}_${parts.slice(0, 4).join('_')}_iFlow_v1`;
}

function estimateArtifactSize(artifact) {
  return Math.round(12 + artifact.shapes_count * 0.8 + (artifact.maps_count || 0) * 1.2 + (artifact.has_scripting ? 4 : 0));
}

module.exports = { runDeploy };
