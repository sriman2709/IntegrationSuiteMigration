const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const { computeComplexityScore, classifyComplexity } = require('./boomi');

async function parseArtifacts(filePath, platform) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parser = new xml2js.Parser({ explicitArray: true, ignoreAttrs: false });
    const result = await parser.parseStringPromise(content);

    const artifacts = [];

    // Handle mule root element
    const root = result['mule'] || result['mule:mule'];
    if (!root) return fallbackArtifacts(filePath, platform);

    const flows = root['flow'] || [];
    for (const flow of flows) {
      const attrs = flow['$'] || {};
      const name = attrs.name || 'Unknown_Flow';

      // Count child elements as shapes
      const childKeys = Object.keys(flow).filter(k => k !== '$');
      let shapesCount = 0;
      let connectorsCount = 0;
      let mapsCount = 0;
      let hasScripting = false;
      let scriptingLevel = 0;
      let hasBatch = false;
      let hasErrorHandling = false;
      let triggerType = 'API';
      const connectorTypes = new Set();

      for (const key of childKeys) {
        const elements = flow[key] || [];
        shapesCount += elements.length;

        if (key.includes('listener') || key.includes('inbound')) {
          triggerType = 'API';
          connectorsCount++;
          connectorTypes.add('HTTP');
        }
        if (key === 'scheduler' || key.includes('cron') || key.includes('timer')) {
          triggerType = 'Schedule';
        }
        if (key.includes('jms') || key.includes('kafka')) {
          triggerType = 'Event';
          connectorsCount++;
          connectorTypes.add(key.includes('kafka') ? 'Kafka' : 'JMS');
        }
        if (key.includes('db:') || key.includes('jdbc')) {
          connectorsCount++;
          connectorTypes.add('Database');
        }
        if (key.includes('file:') || key.includes('sftp')) {
          connectorsCount++;
          connectorTypes.add('SFTP');
        }
        if (key.includes('http:request') || key.includes('http:outbound')) {
          connectorsCount++;
          connectorTypes.add('HTTP');
        }
        if (key.includes('dw:transform') || key.includes('dataweave') || key.includes('ee:transform')) {
          mapsCount++;
          hasScripting = true;
          scriptingLevel = Math.max(scriptingLevel, 2);
        }
        if (key.includes('batch:')) {
          hasBatch = true;
          shapesCount += 5; // batch adds complexity
        }
        if (key.includes('error-handler') || key.includes('on-error')) {
          hasErrorHandling = true;
        }
        if (key.includes('s3') || key.includes('salesforce') || key.includes('sap')) {
          connectorsCount++;
          if (key.includes('salesforce')) connectorTypes.add('Salesforce');
          else if (key.includes('sap')) connectorTypes.add('SAP');
          else if (key.includes('s3')) connectorTypes.add('S3');
        }
      }

      // Check for inbound/listener trigger
      if (flow['http:listener'] || flow['file:inbound-endpoint'] || flow['jms:inbound-endpoint']) {
        const httpListener = flow['http:listener'] || [];
        const fileInbound = flow['file:inbound-endpoint'] || [];
        const jmsInbound = flow['jms:inbound-endpoint'] || [];
        if (fileInbound.length > 0) triggerType = 'Listener';
        if (jmsInbound.length > 0) { triggerType = 'Event'; connectorTypes.add('JMS'); }
      }

      const errorHandlingLevel = hasErrorHandling ? (hasBatch ? 2 : 1) : 0;
      const mapsComplexity = mapsCount > 2 ? 3 : (mapsCount > 1 ? 2 : (mapsCount > 0 ? 1 : 0));
      const primaryConnector = connectorTypes.size > 0 ? [...connectorTypes][0] : 'HTTP';

      // Determine domain from flow name
      let domain = 'INT';
      const nameLower = name.toLowerCase();
      if (nameLower.includes('customer') || nameLower.includes('crm')) domain = 'CRM';
      else if (nameLower.includes('invoice') || nameLower.includes('payment') || nameLower.includes('finance')) domain = 'FIN';
      else if (nameLower.includes('employee') || nameLower.includes('hr') || nameLower.includes('payroll')) domain = 'HR';
      else if (nameLower.includes('order') || nameLower.includes('inventory') || nameLower.includes('supply')) domain = 'SCM';
      else if (nameLower.includes('sftp') || nameLower.includes('file') || nameLower.includes('edi')) domain = 'EXT';
      else if (nameLower.includes('loan') || nameLower.includes('credit') || nameLower.includes('account')) domain = 'FIN';

      const score = computeComplexityScore({
        shapes_count: Math.max(shapesCount, 3),
        connectors_count: Math.max(connectorsCount, 1),
        maps_complexity: mapsComplexity,
        scripting_level: scriptingLevel,
        error_handling_level: errorHandlingLevel,
        dependencies_count: hasBatch ? 2 : 0
      });
      const classification = classifyComplexity(score);

      artifacts.push({
        process_id: `mule-${name.replace(/\s+/g, '_')}-${Date.now()}`,
        name,
        domain,
        platform,
        artifact_type: hasBatch ? 'Batch' : 'Flow',
        trigger_type: triggerType,
        shapes_count: Math.max(shapesCount, 3),
        connectors_count: Math.max(connectorsCount, 1),
        maps_count: mapsCount,
        has_scripting: hasScripting,
        scripting_detail: hasScripting ? 'DataWeave transformation(s)' : null,
        error_handling: errorHandlingLevel >= 2 ? 'try_catch' : (errorHandlingLevel === 1 ? 'basic' : 'none'),
        dependencies_count: hasBatch ? 2 : 0,
        primary_connector: primaryConnector,
        complexity_score: score,
        complexity_level: classification.level,
        tshirt_size: classification.tshirt,
        effort_days: classification.effort,
        readiness: hasScripting ? 'Partial' : 'Auto',
        raw_metadata: { triggerType, hasBatch, mapsCount, connectorsCount, errorHandlingLevel }
      });
    }

    return artifacts.length > 0 ? artifacts : fallbackArtifacts(filePath, platform);
  } catch (err) {
    console.error('MuleSoft parser error:', err.message);
    return fallbackArtifacts(filePath, platform);
  }
}

function fallbackArtifacts(filePath, platform) {
  const size = fs.statSync(filePath).size;
  return [{
    process_id: `mule-fallback-${Date.now()}`,
    name: path.basename(filePath, path.extname(filePath)),
    domain: 'INT',
    platform,
    artifact_type: 'Flow',
    trigger_type: 'API',
    shapes_count: 8,
    connectors_count: 2,
    maps_count: 1,
    has_scripting: true,
    scripting_detail: 'DataWeave (estimated)',
    error_handling: 'basic',
    dependencies_count: 0,
    primary_connector: 'HTTP',
    complexity_score: 42,
    complexity_level: 'Medium',
    tshirt_size: 'M',
    effort_days: 5,
    readiness: 'Partial',
    raw_metadata: { source: 'fallback', fileSize: size }
  }];
}

module.exports = { parseArtifacts };
