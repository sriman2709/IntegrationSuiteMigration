/**
 * Assessment Engine
 * Generates rich, platform-aware assessment output from artifact + platform data.
 * All output is deterministic given the same inputs — safe to re-run.
 */

function runAssessment(artifact, platformData) {
  // Normalise platform: 'tibco-bw5', 'tibco-bw6', 'tibco_bw5' → 'tibco'
  //                     'mule', 'mulesoft-3', 'anypoint' → 'mulesoft'
  const rawPlatform = (artifact.platform || 'boomi').toLowerCase();
  const platform =
    rawPlatform.startsWith('tibco')                          ? 'tibco'    :
    rawPlatform === 'mule' || rawPlatform.startsWith('mule') ? 'mulesoft' :
    rawPlatform === 'pipo' || rawPlatform.includes('pi/po')  ? 'pipo'     :
    rawPlatform === 'boomi' || rawPlatform.includes('boomi') ? 'boomi'    :
    rawPlatform;
  const iflowName = generateIFlowName(artifact);
  const iflowPackage = `${artifact.domain || 'INT'}_Migration_Package_v1`;

  const findings = buildFindings(artifact, platformData, platform);
  const recommendations = buildRecommendations(artifact, platformData, platform, iflowName, iflowPackage);
  const challenges = buildChallenges(artifact, platformData, platform);
  const risks = buildRisks(artifact, platformData, platform);
  const complexityBreakdown = buildComplexityBreakdown(artifact, platformData);
  const iflowAdapters = platformData.iflowAdapters || inferIFlowAdapters(artifact);

  return {
    iflow_name: iflowName,
    iflow_package: iflowPackage,
    migration_approach: getMigrationApproach(artifact),
    complexity_breakdown: complexityBreakdown,
    iflow_adapters: iflowAdapters,
    platform_data_source: platformData._source || 'mock',
    findings,
    recommendations,
    identified_challenges: challenges,
    risk_items: risks,
    connector_mode: platformData._mode || 'mock'
  };
}

function buildFindings(artifact, pd, platform) {
  const findings = [];

  // ── Process Metadata ──────────────────────────────────────────────────────
  findings.push({
    section: 'Process Metadata',
    items: [
      `Platform: ${(artifact.platform || platform).toUpperCase()} | Process ID: ${artifact.process_id || 'N/A'}`,
      `Artifact Type: ${artifact.artifact_type || 'Process'} | Trigger: ${artifact.trigger_type || 'API'}`,
      `Domain: ${artifact.domain || 'INT'} | Folder: ${pd.folder || pd.projectPath || '/Production'}`,
      `Complexity: ${artifact.complexity_score}/100 (${artifact.complexity_level}) | Size: ${artifact.tshirt_size} | Effort: ${artifact.effort_days}d`,
      `Readiness Assessment: ${artifact.readiness || 'Auto'}`,
      `Last Modified: ${pd.lastModified || 'Unknown'}`
    ]
  });

  // ── Structural Analysis ───────────────────────────────────────────────────
  const shapeLabels = (pd.shapes || pd.activities || pd.processors || []).map(s => s.label || s.name).filter(Boolean);
  const structItems = [
    `${artifact.shapes_count} process steps/activities identified`,
    `${artifact.connectors_count} adapter connection(s) configured`,
    `${artifact.maps_count || 0} data mapping(s) — ${getMappingComplexityLabel(artifact.maps_count)} complexity`,
    `${artifact.dependencies_count} sub-process/library dependencies`
  ];
  if (shapeLabels.length > 0) {
    structItems.push(`Key steps: ${shapeLabels.slice(0, 5).join(' → ')}${shapeLabels.length > 5 ? ` (+${shapeLabels.length - 5} more)` : ''}`);
  }
  if (artifact.has_scripting) {
    const scripts = pd.scripts || [];
    structItems.push(`Custom scripting: ${scripts.map(s => `${s.language || s.type || 'script'} — ${s.name || s.id || 'unnamed'}`).join(', ') || artifact.scripting_detail || 'Scripts detected'}`);
  }
  findings.push({ section: 'Structural Analysis', items: structItems });

  // ── Connectors & Adapters ─────────────────────────────────────────────────
  const connItems = [];
  const connTypes = pd.connectorTypes || [artifact.primary_connector || 'HTTP'];
  connItems.push(`Primary connector: ${artifact.primary_connector || 'HTTP/REST'}`);
  connItems.push(`All adapters: ${connTypes.join(', ')}`);
  connItems.push(...getPlatformConnectorNotes(platform, artifact, pd));

  const iflowAdapters = pd.iflowAdapters || inferIFlowAdapters(artifact);
  connItems.push(`Target iFlow adapters: ${iflowAdapters.join(', ')}`);

  if (connTypes.some(c => ['AS2','IDoc'].includes(c))) {
    connItems.push('⚠ B2B/EDI adapters require SAP Integration Suite B2B/EDI Add-on license');
  }
  findings.push({ section: 'Connectors & Adapters', items: connItems });

  // ── Data Mapping Analysis ─────────────────────────────────────────────────
  const mapItems = [];
  if (platform === 'boomi') {
    const maps = pd.mapDescriptions || [];
    maps.forEach(m => mapItems.push(`• ${m}`));
    if (maps.length === 0) mapItems.push(`${artifact.maps_count || 0} data transformation(s) identified`);
    if (artifact.has_scripting) mapItems.push('Groovy transformation scripts must be reimplemented as XSLT or Groovy steps in IS');
  } else if (platform === 'mulesoft') {
    // pd.scripts has enriched objects {type,name,complexity,outputType}; pd.dataWeaveTransforms has raw {body,outputType}
    const transforms = (pd.scripts || []).filter(s => s.type === 'dataweave').length > 0
      ? (pd.scripts || []).filter(s => s.type === 'dataweave')
      : (pd.dataWeaveTransforms || []);
    transforms.forEach((t, i) => {
      const tName       = t.name       || `Transform_${i + 1}`;
      const tComplexity = t.complexity || 'simple';
      const tOut        = t.outputFormat || t.outputType || 'any';
      const tIn         = t.inputFormat  || 'payload';
      mapItems.push(`• ${tName}: ${tComplexity} complexity, ${t.fieldMappings || '?'} field mappings (${tIn} → ${tOut})`);
    });
    if (transforms.length === 0) mapItems.push(`${artifact.maps_count || 0} DataWeave transformation(s) identified`);
    if (artifact.has_scripting) mapItems.push('DataWeave expressions → SAP Message Mapping / XSLT conversion required');
  } else if (platform === 'pipo') {
    mapItems.push(`Mapping type: ${pd.mapping?.type || 'Message Mapping'} — ${pd.mapping?.name || 'N/A'}`);
    mapItems.push(`Field mappings: ${pd.mappingFields || (artifact.maps_count * 18)} fields`);
    mapItems.push('SAP XI Message Mappings can be imported directly into Integration Suite using Migration Tool');
    if (pd.mapping?.type === 'XSLT') mapItems.push('XSLT mappings are directly reusable in IS with minor adapter configuration changes');
  } else if (platform === 'tibco') {
    // Real BW6 extractor returns xsltTransforms; mock/BW5 connector returns mappers
    const mappers = pd.mappers || [];
    const xsltTransforms = pd.xsltTransforms || [];
    if (mappers.length > 0) {
      mappers.forEach(m => mapItems.push(`• ${m.name || 'Mapper'}: ${m.type || 'BW Mapper'}, ${m.fields || '?'} fields${m.hasCustomXPath ? ' (custom XPath — review required)' : ''}`));
    } else if (xsltTransforms.length > 0) {
      xsltTransforms.forEach((x, i) => mapItems.push(`• ${x.name || `Transform_${i + 1}`}: XSLT mapping${x.inputSchema ? ` (${x.inputSchema} → ${x.outputSchema || 'output'})` : ''}`));
    } else {
      mapItems.push(`${artifact.maps_count || 0} TIBCO BW mapper(s) identified`);
    }
    const bwRaw = (artifact.platform || '').toLowerCase();
    const bwSubtype = bwRaw.includes('bw6') ? 'BW6' : bwRaw.includes('bw5') ? 'BW5' : 'BW';
    if (artifact.has_scripting) mapItems.push(`Java activities in ${bwSubtype} must be reimplemented as Groovy Script steps in IS`);
  }
  if (artifact.maps_count > 4) {
    mapItems.push(`⚠ ${artifact.maps_count} mappings indicate significant data transformation effort — allocate dedicated testing time`);
  }
  findings.push({ section: 'Data Mapping Analysis', items: mapItems });

  // ── Error Handling ────────────────────────────────────────────────────────
  const errItems = [`Error handling pattern: ${getErrorHandlingLabel(artifact.error_handling, platform)}`];
  const eh = pd.errorHandling || {};
  if (eh.hasRetry || eh.retryEnabled) errItems.push(`Retry logic: ${eh.retryAttempts || 2} attempts configured`);
  if (eh.hasDeadLetter || eh.hasDLQ) errItems.push(`Dead letter queue: ${eh.deadLetterPath || 'Configured'}`);

  if (artifact.error_handling === 'multi_try_catch') {
    errItems.push('⚠ Multi-level try/catch blocks must be redesigned as IS Exception Subprocess pattern');
    errItems.push('IS supports nested exception subprocesses — map each try/catch level to a dedicated subprocess');
  } else if (artifact.error_handling === 'try_catch') {
    errItems.push('Standard try/catch → IS Exception Subprocess with error end event');
  } else if (artifact.error_handling === 'none') {
    errItems.push('⚠ No error handling detected — recommend adding IS Exception Subprocess for production readiness');
  }
  findings.push({ section: 'Error Handling', items: errItems });

  // ── Deployment Context ────────────────────────────────────────────────────
  const depItems = [];
  if (pd.deployedTo) depItems.push(`Deployed to: ${pd.deployedTo.join(', ')}`);
  if (pd.schedule) depItems.push(`Schedule: ${pd.schedule}`);
  if (pd.environment) depItems.push(`Environment: ${pd.environment}`);
  if (pd.runtime) depItems.push(`Runtime: ${pd.runtime}`);
  if (pd.senderSystem) depItems.push(`Sender System: ${pd.senderSystem} → Receiver: ${pd.receiverSystem}`);
  depItems.push('Target: SAP Integration Suite — Cloud Foundry or Neo environment');
  findings.push({ section: 'Deployment Context', items: depItems.length > 1 ? depItems : ['No specific deployment context available'] });

  return findings;
}

function buildRecommendations(artifact, pd, platform, iflowName, iflowPackage) {
  const recs = [];

  // Conversion approach
  const trigger = artifact.trigger_type;
  const startEvent = trigger === 'Schedule' ? 'Timer Start Event' : trigger === 'Event' ? 'JMS/Kafka Sender Adapter' : trigger === 'Listener' ? 'SFTP/AS2 Sender Adapter' : 'HTTPS Sender Adapter';
  recs.push({
    section: 'iFlow Conversion Approach',
    items: [
      `Target iFlow: ${iflowName} in package ${iflowPackage}`,
      `Start Event: ${startEvent}`,
      `End Event: ${trigger === 'API' ? 'Request-Reply End Event' : 'Message End Event'}`,
      `Externalize all connection parameters via IS Externalized Parameters`,
      `Store credentials in IS Secure Store (not hardcoded in iFlow config)`
    ]
  });

  // Platform-specific recommendations
  if (platform === 'pipo') {
    recs.push({
      section: 'SAP Migration Tool',
      items: [
        'Use SAP Migration Tool (available in IS) to migrate XI scenarios directly',
        'Check SAP Business Accelerator Hub for pre-built IS Integration Packages',
        'Review Integration Advisor for EDI/B2B message type migration',
        `Sender channel (${pd.channel?.sender?.type || 'N/A'}) → IS ${pd.iflowAdapters?.[0] || 'Sender Adapter'}`,
        `Receiver channel (${pd.channel?.receiver?.type || 'N/A'}) → IS ${pd.iflowAdapters?.[1] || 'Receiver Adapter'}`
      ]
    });
  }

  if (artifact.has_scripting) {
    const scripts = pd.scripts || pd.dataWeaveTransforms?.filter(t => t.complexity === 'complex') || [];
    recs.push({
      section: 'Scripting Migration',
      items: [
        'Audit scripts for APIs not supported in IS Groovy sandbox',
        'Replace direct JDBC calls in scripts with IS JDBC Adapter steps',
        platform === 'mulesoft' ? 'Convert DataWeave → IS Message Mapping or Groovy Script step' : 'Convert Groovy/Java → IS Groovy Script or XSLT Message Mapping',
        'Validate scripts do not use System.exit(), file I/O, or unsupported Java classes',
        scripts.length > 0 ? `Key scripts to migrate: ${scripts.slice(0, 3).map(s => s.name).join(', ')}` : 'Review all script steps for IS compatibility'
      ]
    });
  }

  // Adapter configuration
  const iflowAdapters = pd.iflowAdapters || inferIFlowAdapters(artifact);
  recs.push({
    section: 'Adapter Configuration',
    items: [
      `Configure ${iflowAdapters[0] || 'Sender Adapter'} for incoming trigger`,
      `Configure ${iflowAdapters.slice(1).join(', ') || 'Receiver Adapter(s)'} for backend connectivity`,
      'Set up IS Credential Store entries for all adapter credentials',
      'Configure retry policies in adapter settings (not custom script logic)',
      iflowAdapters.some(a => a.includes('AS2')) ? 'Configure AS2 partner agreements in IS Trading Partner Management' : 'Configure adapter timeouts to match upstream SLA requirements'
    ]
  });

  // Deployment
  recs.push({
    section: 'Deployment & Testing',
    items: [
      `Create IS Integration Package: ${iflowPackage}`,
      'Deploy to Development tenant first — validate with synthetic test messages',
      'Run Simulation Mode in IS Designer before package deployment',
      'Use IS Message Processing Log (MPL) to validate end-to-end message flow',
      artifact.complexity_level === 'Complex' ? 'Schedule dedicated QA sprint — minimum 3 test scenarios for Complex artifacts' : 'Run smoke test with sample payload before production cutover'
    ]
  });

  return recs;
}

function buildChallenges(artifact, pd, platform) {
  const challenges = [];

  if (artifact.error_handling === 'multi_try_catch') {
    challenges.push({
      challenge: 'Multi-level error handling redesign',
      description: 'Multiple nested try/catch blocks require restructuring into IS Exception Subprocess pattern',
      impact: 'High', effort: 'Medium',
      mitigation: 'Map each error handling level to a dedicated IS Exception Subprocess; test all error paths'
    });
  }

  if (artifact.has_scripting) {
    const scripts = pd.scripts || [];
    const scriptNames = scripts.map(s => s.name).join(', ') || 'detected scripts';
    challenges.push({
      challenge: `${platform === 'mulesoft' ? 'DataWeave' : 'Custom scripting'} migration`,
      description: `Scripts (${scriptNames}) require manual reimplementation and functional testing in IS sandbox`,
      impact: 'High', effort: 'High',
      mitigation: `Allocate ${Math.ceil(artifact.effort_days * 0.4)}d for script analysis, rewrite, and test coverage`
    });
  }

  if (artifact.connectors_count >= 4) {
    challenges.push({
      challenge: 'Multi-adapter orchestration complexity',
      description: `${artifact.connectors_count} adapters require coordinated error handling and transaction management across systems`,
      impact: 'Medium', effort: 'Medium',
      mitigation: 'Use IS Process Direct Channel for internal orchestration; implement compensating transactions'
    });
  }

  if ((pd.connectorTypes || []).some(c => ['AS2','IDoc'].includes(c))) {
    challenges.push({
      challenge: 'B2B/EDI adapter license requirement',
      description: 'AS2 and IDoc adapters require SAP IS B2B/EDI Add-on license — verify procurement timeline',
      impact: 'High', effort: 'Low',
      mitigation: 'Confirm B2B Add-on license with SAP before sprint start; validate in target IS tenant'
    });
  }

  if (artifact.maps_count > 4) {
    challenges.push({
      challenge: 'High mapping complexity',
      description: `${artifact.maps_count} data mappings require thorough field-level testing with real message payloads`,
      impact: 'Medium', effort: 'Medium',
      mitigation: 'Obtain source and target XSD schemas upfront; use IS Simulation to validate each mapping'
    });
  }

  if (artifact.dependencies_count >= 4) {
    challenges.push({
      challenge: 'Multiple shared resource dependencies',
      description: `${artifact.dependencies_count} shared resources/libraries must be recreated or resolved as IS resources`,
      impact: 'Medium', effort: 'Medium',
      mitigation: 'Catalog all shared resources; create IS equivalents in target tenant before iFlow conversion'
    });
  }

  return challenges;
}

function buildRisks(artifact, pd, platform) {
  const risks = [];
  const score = artifact.complexity_score || 0;

  if (score >= 65) risks.push({ risk: 'High complexity artifact', severity: 'High', probability: 'Medium', description: `Score ${score}/100 — increased rework likelihood; recommend phased conversion with design review checkpoint` });
  if (artifact.has_scripting) risks.push({ risk: 'Custom scripting compatibility', severity: 'High', probability: 'High', description: `${platform === 'mulesoft' ? 'DataWeave' : 'Groovy/Java'} scripts may use APIs not supported in IS sandbox — full functional test required` });
  if ((pd.connectorTypes || []).includes('AS2')) risks.push({ risk: 'AS2 partner agreement migration', severity: 'High', probability: 'Low', description: 'Trading partner agreements and certificates must be reconfigured in IS Trading Partner Management' });
  if (artifact.error_handling === 'multi_try_catch') risks.push({ risk: 'Error handling redesign risk', severity: 'Medium', probability: 'Medium', description: 'Multi-level error handling redesign may introduce regressions — requires comprehensive error path testing' });
  if (artifact.maps_count > 3) risks.push({ risk: 'Mapping accuracy risk', severity: 'Medium', probability: 'Medium', description: `${artifact.maps_count} mappings — field-level regression testing with real production payloads required before go-live` });

  return risks;
}

function buildComplexityBreakdown(artifact, pd) {
  const connTypes = pd.connectorTypes || [artifact.primary_connector || 'HTTP'];
  const scripts = pd.scripts || pd.dataWeaveTransforms || [];

  return {
    shapes: {
      count: artifact.shapes_count,
      label: artifact.shapes_count <= 10 ? 'Low' : artifact.shapes_count <= 25 ? 'Medium' : 'High',
      details: (pd.shapes || pd.activities || pd.processors || []).slice(0, 6).map(s => s.label || s.type).filter(Boolean)
    },
    connectors: {
      count: artifact.connectors_count,
      types: connTypes,
      label: connTypes.length <= 2 ? 'Low' : connTypes.length <= 3 ? 'Medium' : 'High'
    },
    maps: {
      count: artifact.maps_count || 0,
      label: (artifact.maps_count || 0) <= 1 ? 'Low' : (artifact.maps_count || 0) <= 3 ? 'Medium' : 'High',
      descriptions: pd.mapDescriptions || (pd.dataWeaveTransforms || []).map(t => `${t.name} (${t.fieldMappings || '?'} fields)`) || []
    },
    scripting: {
      count: scripts.length,
      languages: [...new Set(scripts.map(s => s.language).filter(Boolean))],
      names: scripts.map(s => s.name).filter(Boolean),
      label: scripts.length === 0 ? 'None' : scripts.length === 1 ? 'Low' : scripts.length <= 2 ? 'Medium' : 'High'
    },
    error_handling: {
      type: artifact.error_handling || 'none',
      label: getErrorHandlingLabel(artifact.error_handling, artifact.platform),
      hasRetry: !!(pd.errorHandling?.hasRetry || pd.errorHandling?.retryEnabled),
      hasDLQ: !!(pd.errorHandling?.hasDeadLetter || pd.errorHandling?.hasDLQ)
    },
    dependencies: {
      count: artifact.dependencies_count || 0,
      names: pd.dependencies || [],
      label: (artifact.dependencies_count || 0) <= 2 ? 'Low' : (artifact.dependencies_count || 0) <= 4 ? 'Medium' : 'High'
    }
  };
}

// ── Helper Functions ──────────────────────────────────────────────────────────

function generateIFlowName(artifact) {
  const parts = (artifact.name || 'Process').replace(/[^a-zA-Z0-9_]/g, '_').split('_').filter(Boolean);
  const domain = artifact.domain || 'INT';
  return `${domain}_${parts.slice(0, 4).join('_')}_iFlow_v1`;
}

function getMigrationApproach(artifact) {
  if (artifact.complexity_level === 'Simple') return 'Direct conversion — standard IS adapters and message mapping with minimal customization required';
  if (artifact.complexity_level === 'Medium') return 'Phased conversion: adapter configuration → message mapping → error handling → functional testing';
  return 'Full redesign with architectural review: decompose into sub-processes, redesign error handling, validate all scripting in IS sandbox';
}

function getMappingComplexityLabel(count) {
  if (!count || count === 0) return 'none';
  if (count <= 1) return 'low';
  if (count <= 3) return 'medium';
  return 'high';
}

function getErrorHandlingLabel(type, platform) {
  const labels = {
    'multi_try_catch': 'Multi-level try/catch (Complex — IS Exception Subprocess required)',
    'try_catch': 'Try/Catch pattern → IS Exception Subprocess',
    'basic': 'Basic error handling → IS Error End Event',
    'none': 'No error handling (not recommended for production)'
  };
  return labels[type] || type || 'Unknown';
}

function getPlatformConnectorNotes(platform, artifact, pd) {
  const notes = [];
  if (platform === 'boomi') {
    notes.push('Boomi connector shapes map 1:1 to IS adapter steps');
    if (artifact.connectors_count >= 3) notes.push('⚠ Multi-connector pattern — verify IS adapter license coverage for all types');
    notes.push('All Boomi connections → IS Credential Store entries (not Boomi Connection Manager)');
  } else if (platform === 'mulesoft') {
    notes.push('MuleSoft Anypoint Connectors → IS adapter equivalents (HTTP, Salesforce, DB, JMS)');
    notes.push('HTTP Listener → IS HTTPS Sender Adapter with service endpoint configured');
    notes.push('Connection config beans → IS Externalized Parameters');
  } else if (platform === 'pipo') {
    notes.push(`Sender channel: ${pd.channel?.sender?.type || 'N/A'} → ${pd.iflowAdapters?.[0] || 'IS Sender Adapter'}`);
    notes.push(`Receiver channel: ${pd.channel?.receiver?.type || 'N/A'} → ${pd.iflowAdapters?.[1] || 'IS Receiver Adapter'}`);
    notes.push('Communication channel configurations → IS adapter parameter externalization');
  } else if (platform === 'tibco') {
    notes.push('TIBCO Shared Resources (connections) → IS Credential Store + adapter configurations');
    notes.push('BW Service Agents → IS adapter equivalents with equivalent retry settings');
    notes.push('TIBCO EMS → IS JMS Adapter (configure broker URL and credentials in IS Secure Store)');
  }
  return notes;
}

function inferIFlowAdapters(artifact) {
  const adapterMap = {
    'Salesforce': 'Salesforce Receiver Adapter', 'SAP S/4HANA': 'OData Receiver (SAP S/4HANA)',
    'SAP SuccessFactors': 'SuccessFactors Adapter', 'SFTP': 'SFTP Adapter',
    'AS2': 'AS2 Receiver Adapter', 'JMS': 'JMS Adapter', 'Kafka': 'Kafka Adapter',
    'HTTP/REST': 'HTTPS Receiver Adapter', 'IDoc': 'IDoc Receiver Adapter',
    'RFC': 'RFC Receiver Adapter', 'JDBC': 'JDBC Adapter', 'SAP Ariba': 'Ariba Receiver Adapter'
  };
  const triggerMap = { 'Schedule': 'Timer Start Event', 'API': 'HTTPS Sender Adapter', 'Event': 'JMS Sender Adapter', 'Listener': 'SFTP Sender Adapter' };
  return [triggerMap[artifact.trigger_type] || 'HTTPS Sender Adapter', adapterMap[artifact.primary_connector] || 'HTTPS Receiver Adapter'].filter(Boolean);
}

module.exports = { runAssessment, generateIFlowName };
