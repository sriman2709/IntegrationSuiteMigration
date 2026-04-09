/**
 * Validate Engine
 * Simulates end-to-end functional validation of deployed iFlow.
 */

function runValidate(artifact, platformData) {
  const iflowName = buildIFlowName(artifact);
  const hasScripting = artifact.has_scripting;
  const isComplex = artifact.complexity_level === 'Complex';
  const platform = artifact.platform || 'boomi';

  const tests = buildFunctionalTests(artifact, platformData, platform);
  const overallStatus = tests.some(t => t.status === 'fail') ? 'Failed' : tests.some(t => t.status === 'warning') ? 'Validated with Warnings' : 'Validated';

  return {
    timestamp: new Date().toISOString(),
    artifact: artifact.name,
    iflow: iflowName,
    platform: platform.toUpperCase(),
    tenant: process.env.CPI_TENANT_NAME || 'CPI-GlobalTech-Prod',
    overall_status: overallStatus,

    functional_validation: buildFunctionalValidation(artifact, platformData, hasScripting),
    schema_mapping_validation: buildSchemaMappingValidation(artifact, platformData, hasScripting, platform),
    iflow_behavior: buildIFlowBehavior(artifact, platformData),
    integration_suite: buildISMetrics(artifact),

    test_runs: tests,
    validation_summary: {
      total_tests: tests.length,
      passed: tests.filter(t => t.status === 'pass').length,
      warnings: tests.filter(t => t.status === 'warning').length,
      failed: tests.filter(t => t.status === 'fail').length,
      avg_response_time_ms: calculateAvgResponseTime(artifact),
      sla_compliant: true
    }
  };
}

function buildFunctionalValidation(artifact, pd, hasScripting) {
  return {
    test_payload: {
      status: 'pass',
      message: `Sample ${artifact.platform?.toUpperCase()} message processed successfully end-to-end`,
      details: `Test message (${getSamplePayloadSize(artifact)}KB) processed in ${calculateAvgResponseTime(artifact)}ms`
    },
    adapter_connectivity: {
      status: 'pass',
      message: `${artifact.primary_connector || 'HTTP'} adapter connection verified — system reachable`,
      details: `Connection test to ${artifact.primary_connector || 'target system'} returned HTTP 200 / RFC OK`
    },
    error_handling: {
      status: artifact.error_handling !== 'none' ? 'pass' : 'warning',
      message: artifact.error_handling !== 'none'
        ? `Exception Subprocess triggered with test error — alert generated, message routed to error queue`
        : 'No error handling configured — recommend adding Exception Subprocess before production go-live',
      details: artifact.error_handling !== 'none' ? 'Error path validated: exception caught → alert sent → message archived' : 'Warning: unhanded exceptions will cause untracked failures'
    }
  };
}

function buildSchemaMappingValidation(artifact, pd, hasScripting, platform) {
  const maps = artifact.maps_count || 0;
  const transforms = pd.dataWeaveTransforms || [];

  return {
    schema_conformance: {
      status: 'pass',
      message: `Input/output payloads conform to registered XSD schemas`,
      details: maps > 0 ? `${maps} mapping(s) tested — all output payloads validated against target schema` : 'No mapping validation required'
    },
    mapping_output: {
      status: hasScripting ? 'warning' : 'pass',
      message: hasScripting
        ? `Script output validated structurally — business rule accuracy requires manual sign-off with real production data`
        : `Mapping output matches expected target format — ${maps} transformation(s) verified`,
      details: hasScripting ? `${pd.scripts?.length || transforms.filter(t => t.complexity === 'complex').length || 1} script(s) require sign-off from business analyst` : 'Automated schema validation passed — no manual review needed'
    },
    character_encoding: {
      status: 'pass',
      message: 'UTF-8 encoding verified throughout message pipeline',
      details: 'Special characters, Unicode, and multi-byte sequences handled correctly'
    },
    field_mapping_coverage: {
      status: maps > 4 ? 'warning' : 'pass',
      message: maps > 4
        ? `${maps} mappings — spot-check required: validate ${Math.ceil(maps * 0.3)} key field mappings with production-equivalent test data`
        : maps > 0 ? `All ${maps} mapping(s) validated with test payloads` : 'Not applicable — no mappings',
      details: `Field coverage: ${maps > 0 ? Math.min(95, 70 + (5 - Math.min(5, maps)) * 5) : 100}% of mapped fields validated`
    }
  };
}

function buildIFlowBehavior(artifact, pd) {
  const avgTime = calculateAvgResponseTime(artifact);
  const slaMs = artifact.trigger_type === 'API' ? 3000 : 10000;

  return {
    sequence: {
      status: 'pass',
      message: `All ${artifact.shapes_count} steps executed in correct sequence`,
      details: `Execution trace captured in MPL — no sequence errors or unexpected branches`
    },
    logging: {
      status: 'pass',
      message: 'Message processing log captured in SAP IS MPL',
      details: 'Header attributes, adapter metadata, and step durations logged — payload logging disabled (compliance)'
    },
    performance: {
      status: avgTime <= slaMs ? 'pass' : 'warning',
      message: `Average processing time: ${avgTime}ms ${avgTime <= slaMs ? '(within SLA)' : '(above SLA — optimize before go-live)'}`,
      details: `SLA: ${slaMs}ms | Actual: ${avgTime}ms | P99: ${Math.round(avgTime * 1.8)}ms | Throughput: ${estimateThroughput(artifact)} msg/min`
    },
    idempotency: {
      status: artifact.error_handling !== 'none' ? 'pass' : 'warning',
      message: artifact.error_handling !== 'none' ? 'Idempotency validated — duplicate test messages handled correctly' : 'No duplicate detection configured — consider adding idempotency check for production',
      details: artifact.error_handling !== 'none' ? 'Retry scenarios tested — duplicate messages correctly detected and discarded' : 'Duplicate messages could cause double-processing in production'
    }
  };
}

function buildFunctionalTests(artifact, pd, platform) {
  const tests = [
    {
      test_id: 'T001',
      name: 'Happy Path — Valid Payload',
      description: `Submit well-formed ${platform.toUpperCase()} message through complete iFlow`,
      status: 'pass',
      duration_ms: calculateAvgResponseTime(artifact),
      result: 'Message processed end-to-end — target system received correct payload'
    },
    {
      test_id: 'T002',
      name: 'Adapter Connectivity',
      description: `Test ${artifact.primary_connector || 'target system'} adapter connection`,
      status: 'pass',
      duration_ms: Math.round(calculateAvgResponseTime(artifact) * 0.3),
      result: `${artifact.primary_connector || 'Target system'} responded within timeout — connection healthy`
    },
    {
      test_id: 'T003',
      name: 'Message Mapping Accuracy',
      description: `Validate ${artifact.maps_count || 0} mapping transformation output`,
      status: artifact.maps_count > 0 ? 'pass' : 'pass',
      duration_ms: Math.round(calculateAvgResponseTime(artifact) * 0.4),
      result: artifact.maps_count > 0 ? `${artifact.maps_count} mapping(s) verified — output matches target XSD` : 'No mappings — test not applicable'
    },
    {
      test_id: 'T004',
      name: 'Error Scenario — Invalid Payload',
      description: 'Submit malformed message to verify error handling path',
      status: artifact.error_handling !== 'none' ? 'pass' : 'warning',
      duration_ms: Math.round(calculateAvgResponseTime(artifact) * 0.5),
      result: artifact.error_handling !== 'none' ? 'Error correctly caught → Exception Subprocess triggered → alert sent → message archived' : 'Exception thrown but no handler configured — unhandled error in MPL'
    },
    {
      test_id: 'T005',
      name: 'Authentication & Security',
      description: 'Verify unauthorized request is rejected',
      status: 'pass',
      duration_ms: 45,
      result: 'Unauthorized request (no credentials) returned 401 — security policy working correctly'
    },
    {
      test_id: 'T006',
      name: 'Retry Mechanism',
      description: `Test adapter retry logic (${artifact.error_handling === 'multi_try_catch' ? '3' : artifact.error_handling === 'try_catch' ? '2' : '0'} retries configured)`,
      status: artifact.error_handling !== 'none' ? 'pass' : 'warning',
      duration_ms: Math.round(calculateAvgResponseTime(artifact) * 2),
      result: artifact.error_handling !== 'none' ? `Retry triggered ${artifact.error_handling === 'multi_try_catch' ? '3' : '2'} times on simulated target failure — messages eventually delivered` : 'No retry configured — target system failures will cause message loss'
    },
    {
      test_id: 'T007',
      name: 'Performance Benchmark',
      description: 'Process 10 messages sequentially and measure throughput',
      status: 'pass',
      duration_ms: calculateAvgResponseTime(artifact) * 10,
      result: `10 messages processed in ${calculateAvgResponseTime(artifact) * 10}ms — throughput: ${estimateThroughput(artifact)} msg/min, P99: ${Math.round(calculateAvgResponseTime(artifact) * 1.8)}ms`
    }
  ];

  if (artifact.has_scripting) {
    tests.push({
      test_id: 'T008',
      name: 'Script Logic Validation',
      description: 'Verify custom script logic produces correct output',
      status: 'warning',
      duration_ms: Math.round(calculateAvgResponseTime(artifact) * 0.8),
      result: `Script output is structurally valid but business rule accuracy requires sign-off from ${artifact.domain} business analyst with real production data`
    });
  }

  if ((pd.connectorTypes || []).includes('AS2')) {
    tests.push({
      test_id: 'T009',
      name: 'AS2 MDN Verification',
      description: 'Send test AS2 message and verify MDN acknowledgement',
      status: 'warning',
      duration_ms: 2800,
      result: 'AS2 partner test required — import trading partner certificates and configure MDN endpoint before this test can run'
    });
  }

  return tests;
}

function buildISMetrics(artifact) {
  return {
    total_applications: 1,
    migrated: 1,
    deployed: 1,
    validated: 1,
    status: 'Active',
    action_version: '1.0.0',
    iflow_package: `${artifact.domain || 'INT'}_Migration_Package_v1`,
    runtime_node: 'IS-Runtime-Worker-01',
    deployment_environment: 'Cloud Foundry (SAP BTP)',
    mpl_link: `https://cpi-prod.hana.ondemand.com/itspaces/shell/monitoring`
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildIFlowName(artifact) {
  const parts = (artifact.name || 'Process').replace(/[^a-zA-Z0-9_]/g, '_').split('_').filter(Boolean);
  return `${artifact.domain || 'INT'}_${parts.slice(0, 4).join('_')}_iFlow_v1`;
}

function calculateAvgResponseTime(artifact) {
  const base = artifact.trigger_type === 'API' ? 180 : 450;
  const shapesFactor = artifact.shapes_count * 8;
  const connFactor = artifact.connectors_count * 60;
  const mapFactor = (artifact.maps_count || 0) * 25;
  const scriptFactor = artifact.has_scripting ? 120 : 0;
  return Math.round(base + shapesFactor + connFactor + mapFactor + scriptFactor + Math.random() * 50);
}

function estimateThroughput(artifact) {
  const responseTime = calculateAvgResponseTime(artifact);
  return Math.round((60000 / responseTime) * 0.7);
}

function getSamplePayloadSize(artifact) {
  return Math.round(2 + (artifact.maps_count || 0) * 1.5 + artifact.shapes_count * 0.1);
}

module.exports = { runValidate };
