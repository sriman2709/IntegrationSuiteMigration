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

    // Handle bw:BusinessWorksProject root
    const root = result['bw:BusinessWorksProject'] || result['BusinessWorksProject'];
    if (!root) return fallbackArtifacts(filePath, platform);

    // Collect all ProcessDef elements (may be in different namespaces)
    const processDefs = [];
    const keys = Object.keys(root);
    for (const key of keys) {
      if (key.includes('ProcessDef')) {
        processDefs.push(...(root[key] || []));
      }
    }

    for (const proc of processDefs) {
      const attrs = proc['$'] || {};
      const name = attrs.name || 'Unknown_Process';

      // Count activities
      const activities = proc['pd:activity'] || proc['activity'] || [];
      const activityCountEl = (proc['pd:activityCount'] || proc['activityCount'] || ['0'])[0];
      const activityCount = parseInt(typeof activityCountEl === 'string' ? activityCountEl : (activityCountEl['_'] || '0')) || activities.length;

      const triggerEl = (proc['pd:trigger'] || proc['trigger'] || [{}])[0];
      const triggerAttrs = typeof triggerEl === 'object' ? (triggerEl['$'] || {}) : {};
      const triggerType = triggerAttrs.type || 'HTTPReceiver';

      const domainEl = (proc['pd:domain'] || proc['domain'] || ['SCM'])[0];
      const domain = typeof domainEl === 'string' ? domainEl : (domainEl['_'] || 'SCM');

      const errorHandlingEl = (proc['pd:errorHandling'] || proc['errorHandling'] || [{}])[0];
      const errorType = typeof errorHandlingEl === 'object' ? ((errorHandlingEl['$'] || {}).type || 'none') : 'none';

      const sharedModules = proc['pd:sharedModules'] || proc['sharedModules'] || [];
      const modulesCount = sharedModules.length > 0
        ? ((sharedModules[0]['pd:module'] || sharedModules[0]['module'] || []).length)
        : 0;

      // Detect connectors from activity types
      const connectorTypes = new Set();
      for (const act of activities) {
        const actAttrs = act['$'] || {};
        const actType = actAttrs.type || '';
        if (actType.includes('jdbc') || actType.includes('db')) connectorTypes.add('JDBC');
        if (actType.includes('http')) connectorTypes.add('HTTP');
        if (actType.includes('jms')) connectorTypes.add('JMS');
        if (actType.includes('smtp') || actType.includes('mail')) connectorTypes.add('SMTP');
        if (actType.includes('file')) connectorTypes.add('File');
        if (actType.includes('ftp') || actType.includes('sftp')) connectorTypes.add('SFTP');
      }
      const connectorsCount = Math.max(connectorTypes.size, 1);

      // Detect scripting (mapper with xpath)
      let mapsCount = 0;
      let scriptingLevel = 0;
      for (const act of activities) {
        const actAttrs = act['$'] || {};
        const actType = actAttrs.type || '';
        if (actType.includes('mapper') || actType.includes('transform')) {
          mapsCount++;
          const xpathEl = act['pd:xpath'] || act['xpath'] || [];
          if (xpathEl.length > 0) {
            const xpathAttrs = xpathEl[0]['$'] || {};
            const mappingCount = parseInt(xpathAttrs.mappings || 0);
            if (mappingCount > 30) scriptingLevel = 2;
            else if (mappingCount > 0) scriptingLevel = 1;
          }
        }
      }

      const hasScripting = scriptingLevel > 0;
      const errorHandlingLevel = errorType === 'CatchAll' ? 2 : (errorType === 'none' ? 0 : 1);
      const mapsComplexity = mapsCount >= 3 ? 3 : (mapsCount >= 2 ? 2 : (mapsCount >= 1 ? 1 : 0));

      // Map trigger type
      let mappedTrigger = 'API';
      if (triggerType.includes('Timer') || triggerType.includes('Schedule')) mappedTrigger = 'Schedule';
      else if (triggerType.includes('JMS')) mappedTrigger = 'Event';
      else if (triggerType.includes('HTTP')) mappedTrigger = 'API';
      else if (triggerType.includes('File') || triggerType.includes('SFTP')) mappedTrigger = 'Listener';

      const primaryConnector = connectorTypes.size > 0 ? [...connectorTypes][0] : 'HTTP';

      const score = computeComplexityScore({
        shapes_count: activityCount,
        connectors_count: connectorsCount,
        maps_complexity: mapsComplexity,
        scripting_level: scriptingLevel,
        error_handling_level: errorHandlingLevel,
        dependencies_count: modulesCount
      });
      const classification = classifyComplexity(score);

      artifacts.push({
        process_id: `tibco-${name.replace(/\s+/g, '_')}-${Date.now()}`,
        name,
        domain,
        platform,
        artifact_type: 'ProcessDef',
        trigger_type: mappedTrigger,
        shapes_count: activityCount,
        connectors_count: connectorsCount,
        maps_count: mapsCount,
        has_scripting: hasScripting,
        scripting_detail: hasScripting ? 'TIBCO Mapper XPath expressions' : null,
        error_handling: errorHandlingLevel >= 2 ? 'try_catch' : (errorHandlingLevel === 1 ? 'basic' : 'none'),
        dependencies_count: modulesCount,
        primary_connector: primaryConnector,
        complexity_score: score,
        complexity_level: classification.level,
        tshirt_size: classification.tshirt,
        effort_days: classification.effort,
        readiness: hasScripting ? 'Partial' : (score > 60 ? 'Manual' : 'Auto'),
        raw_metadata: { activityCount, triggerType, domain, connectorsCount, mapsCount, modulesCount }
      });
    }

    return artifacts.length > 0 ? artifacts : fallbackArtifacts(filePath, platform);
  } catch (err) {
    console.error('TIBCO parser error:', err.message);
    return fallbackArtifacts(filePath, platform);
  }
}

function fallbackArtifacts(filePath, platform) {
  const size = fs.statSync(filePath).size;
  return [{
    process_id: `tibco-fallback-${Date.now()}`,
    name: path.basename(filePath, path.extname(filePath)),
    domain: 'SCM',
    platform,
    artifact_type: 'ProcessDef',
    trigger_type: 'API',
    shapes_count: 12,
    connectors_count: 2,
    maps_count: 1,
    has_scripting: false,
    scripting_detail: null,
    error_handling: 'basic',
    dependencies_count: 1,
    primary_connector: 'HTTP',
    complexity_score: 35,
    complexity_level: 'Medium',
    tshirt_size: 'M',
    effort_days: 5,
    readiness: 'Partial',
    raw_metadata: { source: 'fallback', fileSize: size }
  }];
}

module.exports = { parseArtifacts };
