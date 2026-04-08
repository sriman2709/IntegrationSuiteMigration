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

    // Handle xi:IntegrationRepository root
    const root = result['xi:IntegrationRepository'] || result['IntegrationRepository'];
    if (!root) return fallbackArtifacts(filePath, platform);

    const scenarios = root['xi:IntegrationScenario'] || root['IntegrationScenario'] || [];
    for (const scenario of scenarios) {
      const attrs = scenario['$'] || {};
      const name = attrs.name || 'Unknown_Interface';
      const namespace = attrs.namespace || '';

      const outbound = (scenario['xi:OutboundInterface'] || scenario['OutboundInterface'] || [{}])[0];
      const inbound = (scenario['xi:InboundInterface'] || scenario['InboundInterface'] || [{}])[0];
      const determination = (scenario['xi:InterfaceDetermination'] || scenario['InterfaceDetermination'] || [{}])[0];

      const outAttrs = (outbound['$'] || {});
      const inAttrs = (inbound['$'] || {});
      const detAttrs = (determination['$'] || {});

      const senderType = outAttrs.type || 'IDoc';
      const receiverType = inAttrs.type || 'HTTP';

      const adapters = (inbound['xi:Adapters'] || inbound['Adapters'] || [{}])[0];
      const adapterList = adapters['xi:Adapter'] || adapters['Adapter'] || [];
      const adapterCount = adapterList.length || 2;

      const mappings = parseInt(detAttrs.mappings || 1);
      const conditions = parseInt(detAttrs.conditions || 0);
      const scripts = parseInt(detAttrs.scripts || 0);

      const hasEDI = receiverType.includes('EDI') || receiverType.includes('EDIFACT') || senderType.includes('EDI');
      const hasScripting = scripts > 0;

      // Estimate shapes based on complexity indicators
      const shapesCount = 8 + (mappings * 3) + (conditions * 2) + (scripts * 2);
      const connectorsCount = adapterCount;
      const mapsComplexity = hasEDI ? 5 : (mappings > 2 ? 3 : (mappings > 1 ? 2 : 1));
      const scriptingLevel = scripts > 1 ? 2 : (scripts === 1 ? 1 : 0);
      const errorHandlingLevel = conditions > 1 ? 2 : 1;

      // Determine domain from namespace
      let domain = 'INT';
      const ns = namespace.toLowerCase();
      if (ns.includes('customer') || ns.includes('crm')) domain = 'CRM';
      else if (ns.includes('finance') || ns.includes('fi')) domain = 'FIN';
      else if (ns.includes('hr') || ns.includes('employee')) domain = 'HR';
      else if (ns.includes('supply') || ns.includes('purchase') || ns.includes('scm')) domain = 'SCM';

      // Determine trigger from sender type
      let triggerType = 'Event';
      if (senderType === 'RFC') triggerType = 'API';
      else if (senderType === 'IDoc') triggerType = 'Event';
      else if (senderType === 'REST' || senderType === 'HTTP') triggerType = 'API';

      const score = computeComplexityScore({
        shapes_count: shapesCount,
        connectors_count: connectorsCount,
        maps_complexity: mapsComplexity,
        scripting_level: scriptingLevel,
        error_handling_level: errorHandlingLevel,
        dependencies_count: conditions
      });
      const classification = classifyComplexity(score);

      artifacts.push({
        process_id: `pipo-${name.replace(/\s+/g, '_')}-${Date.now()}`,
        name,
        domain,
        platform,
        artifact_type: 'IntegrationScenario',
        trigger_type: triggerType,
        shapes_count: shapesCount,
        connectors_count: connectorsCount,
        maps_count: mappings,
        has_scripting: hasScripting,
        scripting_detail: hasScripting ? `${scripts} XSLT/ABAP script(s)` : null,
        error_handling: errorHandlingLevel >= 2 ? 'try_catch' : 'basic',
        dependencies_count: conditions,
        primary_connector: senderType,
        complexity_score: score,
        complexity_level: classification.level,
        tshirt_size: classification.tshirt,
        effort_days: classification.effort,
        readiness: hasEDI ? 'Manual' : (hasScripting ? 'Partial' : 'Auto'),
        raw_metadata: { senderType, receiverType, mappings, conditions, scripts, namespace }
      });
    }

    return artifacts.length > 0 ? artifacts : fallbackArtifacts(filePath, platform);
  } catch (err) {
    console.error('PIPO parser error:', err.message);
    return fallbackArtifacts(filePath, platform);
  }
}

function fallbackArtifacts(filePath, platform) {
  const size = fs.statSync(filePath).size;
  return [{
    process_id: `pipo-fallback-${Date.now()}`,
    name: path.basename(filePath, path.extname(filePath)),
    domain: 'INT',
    platform,
    artifact_type: 'IntegrationScenario',
    trigger_type: 'Event',
    shapes_count: 10,
    connectors_count: 2,
    maps_count: 1,
    has_scripting: false,
    scripting_detail: null,
    error_handling: 'basic',
    dependencies_count: 0,
    primary_connector: 'IDoc',
    complexity_score: 30,
    complexity_level: 'Simple',
    tshirt_size: 'S',
    effort_days: 2,
    readiness: 'Auto',
    raw_metadata: { source: 'fallback', fileSize: size }
  }];
}

module.exports = { parseArtifacts };
