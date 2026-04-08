const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');

async function parseArtifacts(filePath, platform) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parser = new xml2js.Parser({ explicitArray: true, ignoreAttrs: false });
    const result = await parser.parseStringPromise(content);

    const artifacts = [];

    // Handle bns:Components root
    const root = result['bns:Components'] || result['Components'];
    if (!root) return fallbackArtifacts(filePath, platform);

    const components = root['bns:Component'] || root['Component'] || [];
    for (const comp of components) {
      const attrs = comp['$'] || {};
      const name = attrs.name || attrs.componentId || 'Unknown Process';
      const componentId = attrs.componentId || `comp-${Date.now()}`;
      const procObj = (comp['bns:process'] || comp['process'] || [{}])[0];

      const shapesEl = (procObj['bns:shapes'] || procObj['shapes'] || [{}])[0];
      const shapesCount = parseInt((shapesEl['$'] || {}).count || 0);

      const connectorsEl = (procObj['bns:connectors'] || procObj['connectors'] || [{}])[0];
      const connectorsCount = parseInt((connectorsEl['$'] || {}).count || 0);

      const mapsEl = (procObj['bns:maps'] || procObj['maps'] || [{}])[0];
      const mapsCount = parseInt((mapsEl['$'] || {}).count || 0);

      const scriptsEl = (procObj['bns:scripts'] || procObj['scripts'] || [{}])[0];
      const scriptsCount = parseInt((scriptsEl['$'] || {}).count || 0);
      const hasScripting = scriptsCount > 0;
      const scriptingDetail = hasScripting ? `${scriptsCount} Groovy script(s)` : null;

      const errorEl = (procObj['bns:errorHandling'] || procObj['errorHandling'] || [{}])[0];
      const errorType = (errorEl['$'] || {}).type || 'basic';

      const depsEl = (procObj['bns:dependencies'] || procObj['dependencies'] || [{}])[0];
      const depsCount = parseInt((depsEl['$'] || {}).count || 0);

      const triggerEl = (procObj['bns:trigger'] || procObj['trigger'] || [{}])[0];
      const triggerType = (triggerEl['$'] || {}).type || 'API';

      const domainEl = (procObj['bns:domain'] || procObj['domain'] || ['CRM'])[0];
      const domain = typeof domainEl === 'string' ? domainEl : (domainEl['_'] || 'CRM');

      // Determine primary connector from connectors list
      const connectorList = (connectorsEl['bns:connector'] || connectorsEl['connector'] || []);
      const primaryConnector = connectorList.length > 0
        ? ((connectorList[0]['$'] || {}).type || 'HTTP')
        : 'HTTP';

      // Scripting level: 0=none,1=light,2=medium,3=heavy
      let scriptingLevel = 0;
      if (scriptsCount > 0) {
        const totalLines = parseInt((scriptsEl['$'] || {}).totalLines || 0);
        if (totalLines > 150) scriptingLevel = 3;
        else if (totalLines > 50) scriptingLevel = 2;
        else scriptingLevel = 1;
      }

      // Error handling level
      const errorLevelMap = { none: 0, basic: 1, try_catch: 2, multi_try_catch: 3 };
      const errorHandlingLevel = errorLevelMap[errorType] !== undefined ? errorLevelMap[errorType] : 1;

      // Maps complexity: 0=none,1=single_simple,2=single_medium,3=cross_simple,4=cross_medium,5=cross_complex_edi
      let mapsComplexity = 0;
      if (mapsCount === 0) mapsComplexity = 0;
      else if (mapsCount === 1) mapsComplexity = 1;
      else if (mapsCount <= 3) mapsComplexity = 2;
      else if (mapsCount <= 5) mapsComplexity = 3;
      else mapsComplexity = 4;

      const score = computeComplexityScore({
        shapes_count: shapesCount,
        connectors_count: connectorsCount,
        maps_complexity: mapsComplexity,
        scripting_level: scriptingLevel,
        error_handling_level: errorHandlingLevel,
        dependencies_count: depsCount
      });
      const classification = classifyComplexity(score);

      artifacts.push({
        process_id: componentId,
        name,
        domain,
        platform,
        artifact_type: 'Process',
        trigger_type: triggerType,
        shapes_count: shapesCount,
        connectors_count: connectorsCount,
        maps_count: mapsCount,
        has_scripting: hasScripting,
        scripting_detail: scriptingDetail,
        error_handling: errorType,
        dependencies_count: depsCount,
        primary_connector: primaryConnector,
        complexity_score: score,
        complexity_level: classification.level,
        tshirt_size: classification.tshirt,
        effort_days: classification.effort,
        readiness: hasScripting ? 'Manual' : (score > 50 ? 'Partial' : 'Auto'),
        raw_metadata: { componentId, shapesCount, connectorsCount, mapsCount, scriptsCount, errorType, depsCount, triggerType, domain }
      });
    }

    return artifacts.length > 0 ? artifacts : fallbackArtifacts(filePath, platform);
  } catch (err) {
    console.error('Boomi parser error:', err.message);
    return fallbackArtifacts(filePath, platform);
  }
}

function fallbackArtifacts(filePath, platform) {
  const size = fs.statSync(filePath).size;
  const estimated = Math.max(1, Math.floor(size / 2000));
  return [{
    process_id: `fallback-${Date.now()}`,
    name: path.basename(filePath, path.extname(filePath)),
    domain: 'Unknown',
    platform,
    artifact_type: 'Process',
    trigger_type: 'API',
    shapes_count: Math.min(15, estimated * 3),
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

function computeRawScore(param, value) {
  switch (param) {
    case 'shapes':
      if (value <= 5) return 2;
      if (value <= 10) return 4;
      if (value <= 20) return 6;
      if (value <= 35) return 8;
      return 10;
    case 'connectors':
      if (value <= 1) return 2;
      if (value <= 2) return 4;
      if (value <= 3) return 6;
      if (value <= 4) return 8;
      return 10;
    case 'maps':
      const mapScores = [0, 2, 4, 6, 8, 10];
      return mapScores[Math.min(value, 5)];
    case 'scripting':
      if (value === 0) return 0;
      if (value === 1) return 3;
      if (value === 2) return 6;
      return 10;
    case 'error_handling':
      if (value === 0) return 1;
      if (value === 1) return 3;
      if (value === 2) return 6;
      return 10;
    case 'dependencies':
      if (value === 0) return 0;
      if (value <= 2) return 3;
      if (value <= 4) return 6;
      return 10;
    default:
      return 0;
  }
}

function computeComplexityScore(artifact) {
  const shapesRaw = computeRawScore('shapes', artifact.shapes_count || 0);
  const connectorsRaw = computeRawScore('connectors', artifact.connectors_count || 0);
  const mapsRaw = computeRawScore('maps', artifact.maps_complexity || 1);
  const scriptingRaw = computeRawScore('scripting', artifact.scripting_level || (artifact.has_scripting ? 2 : 0));
  const errorRaw = computeRawScore('error_handling', artifact.error_handling_level || 1);
  const depsRaw = computeRawScore('dependencies', artifact.dependencies_count || 0);

  const raw = (shapesRaw * 1.5) + (connectorsRaw * 2.0) + (mapsRaw * 2.5) + (scriptingRaw * 2.0) + (errorRaw * 1.0) + (depsRaw * 1.0);
  const maxRaw = (10 * 1.5) + (10 * 2.0) + (10 * 2.5) + (10 * 2.0) + (10 * 1.0) + (10 * 1.0);
  return Math.round((raw / maxRaw) * 100);
}

function classifyComplexity(score) {
  if (score <= 34) return { level: 'Simple', tshirt: score <= 20 ? 'XS' : 'S', effort: score <= 20 ? 1 : 2 };
  if (score <= 64) return { level: 'Medium', tshirt: 'M', effort: 5 };
  if (score <= 79) return { level: 'Complex', tshirt: 'L', effort: 12 };
  return { level: 'Complex', tshirt: 'XL', effort: 18 };
}

module.exports = { parseArtifacts, computeComplexityScore, classifyComplexity, computeRawScore };
