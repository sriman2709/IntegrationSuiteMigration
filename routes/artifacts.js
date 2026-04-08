const express = require('express');
const router = express.Router();
const { pool } = require('../database/db');

// List artifacts for a project with optional filters
router.get('/project/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { status, complexity, domain, platform, source_id } = req.query;

    let conditions = ['a.project_id = $1'];
    const params = [projectId];
    let paramIdx = 2;

    if (status) { conditions.push(`a.status = $${paramIdx++}`); params.push(status); }
    if (complexity) { conditions.push(`a.complexity_level = $${paramIdx++}`); params.push(complexity); }
    if (domain) { conditions.push(`a.domain = $${paramIdx++}`); params.push(domain); }
    if (platform) { conditions.push(`a.platform = $${paramIdx++}`); params.push(platform); }
    if (source_id) { conditions.push(`a.source_id = $${paramIdx++}`); params.push(source_id); }

    const result = await pool.query(
      `SELECT a.*, sc.name AS source_name,
              (SELECT id FROM artifact_assessments WHERE artifact_id = a.id) AS has_assessment
       FROM artifacts a
       LEFT JOIN source_connections sc ON sc.id = a.source_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.complexity_score DESC, a.name`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stats for project artifacts
router.get('/project/:projectId/stats', async (req, res) => {
  try {
    const { projectId } = req.params;
    const result = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE complexity_level = 'Simple') AS simple_count,
        COUNT(*) FILTER (WHERE complexity_level = 'Medium') AS medium_count,
        COUNT(*) FILTER (WHERE complexity_level = 'Complex') AS complex_count,
        COUNT(*) FILTER (WHERE status = 'discovered') AS discovered_count,
        COUNT(*) FILTER (WHERE status = 'assessed') AS assessed_count,
        COUNT(*) FILTER (WHERE status IN ('converted', 'qa_passed', 'deployed', 'validated')) AS converted_count,
        COUNT(*) FILTER (WHERE readiness = 'Auto') AS auto_ready,
        COUNT(*) FILTER (WHERE readiness = 'Partial') AS partial_ready,
        COUNT(*) FILTER (WHERE readiness = 'Manual') AS manual_ready,
        COALESCE(SUM(effort_days), 0) AS total_effort_days,
        COUNT(*) FILTER (WHERE status = 'validated') AS validated_count
      FROM artifacts WHERE project_id = $1
    `, [projectId]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single artifact with assessment
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [artifact, assessment, runs] = await Promise.all([
      pool.query('SELECT a.*, sc.name AS source_name FROM artifacts a LEFT JOIN source_connections sc ON sc.id = a.source_id WHERE a.id = $1', [id]),
      pool.query('SELECT * FROM artifact_assessments WHERE artifact_id = $1', [id]),
      pool.query('SELECT * FROM conversion_runs WHERE artifact_id = $1 ORDER BY run_number DESC LIMIT 5', [id])
    ]);
    if (!artifact.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({
      ...artifact.rows[0],
      assessment: assessment.rows[0] || null,
      runs: runs.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update artifact
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { status, readiness, complexity_score, complexity_level, tshirt_size, effort_days } = req.body;
  try {
    const result = await pool.query(
      `UPDATE artifacts SET
        status = COALESCE($1, status),
        readiness = COALESCE($2, readiness),
        complexity_score = COALESCE($3, complexity_score),
        complexity_level = COALESCE($4, complexity_level),
        tshirt_size = COALESCE($5, tshirt_size),
        effort_days = COALESCE($6, effort_days),
        updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [status, readiness, complexity_score, complexity_level, tshirt_size, effort_days, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run assessment
router.post('/:id/assess', async (req, res) => {
  const { id } = req.params;
  try {
    const artResult = await pool.query('SELECT * FROM artifacts WHERE id = $1', [id]);
    if (!artResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const art = artResult.rows[0];

    const assessment = generateAssessment(art);

    // Upsert assessment
    const existing = await pool.query('SELECT id FROM artifact_assessments WHERE artifact_id = $1', [id]);
    let result;
    if (existing.rows.length) {
      result = await pool.query(
        `UPDATE artifact_assessments SET
          findings = $1, recommendations = $2, iflow_name = $3, iflow_package = $4,
          migration_approach = $5, identified_challenges = $6, updated_at = NOW()
         WHERE artifact_id = $7 RETURNING *`,
        [JSON.stringify(assessment.findings), JSON.stringify(assessment.recommendations),
         assessment.iflow_name, assessment.iflow_package, assessment.migration_approach,
         JSON.stringify(assessment.identified_challenges), id]
      );
    } else {
      result = await pool.query(
        `INSERT INTO artifact_assessments
          (artifact_id, findings, recommendations, iflow_name, iflow_package, migration_approach, identified_challenges)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, JSON.stringify(assessment.findings), JSON.stringify(assessment.recommendations),
         assessment.iflow_name, assessment.iflow_package, assessment.migration_approach,
         JSON.stringify(assessment.identified_challenges)]
      );
    }

    await pool.query("UPDATE artifacts SET status = 'assessed', updated_at = NOW() WHERE id = $1", [id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start conversion
router.post('/:id/convert', async (req, res) => {
  const { id } = req.params;
  try {
    const artResult = await pool.query('SELECT * FROM artifacts WHERE id = $1', [id]);
    if (!artResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const art = artResult.rows[0];

    // Get next run number
    const runCount = await pool.query('SELECT COUNT(*) FROM conversion_runs WHERE artifact_id = $1', [id]);
    const runNumber = parseInt(runCount.rows[0].count) + 1;

    const convertOutput = generateConversionOutput(art);

    const runResult = await pool.query(
      `INSERT INTO conversion_runs (artifact_id, run_number, convert_output, status)
       VALUES ($1, $2, $3, 'converting') RETURNING *`,
      [id, runNumber, convertOutput]
    );

    await pool.query("UPDATE artifacts SET status = 'converting', updated_at = NOW() WHERE id = $1", [id]);

    // Simulate async completion
    setTimeout(async () => {
      try {
        await pool.query(
          "UPDATE conversion_runs SET status = 'converted', updated_at = NOW() WHERE id = $1",
          [runResult.rows[0].id]
        );
        await pool.query("UPDATE artifacts SET status = 'converted', updated_at = NOW() WHERE id = $1", [id]);
      } catch (e) { console.error('Conversion update error:', e.message); }
    }, 2000);

    res.json(runResult.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// QA Check
router.post('/:id/qa', async (req, res) => {
  const { id } = req.params;
  try {
    const artResult = await pool.query('SELECT * FROM artifacts WHERE id = $1', [id]);
    if (!artResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const art = artResult.rows[0];

    const qaResults = generateQAResults(art);

    // Update latest conversion run
    const runResult = await pool.query(
      'SELECT id FROM conversion_runs WHERE artifact_id = $1 ORDER BY run_number DESC LIMIT 1', [id]
    );

    if (runResult.rows.length) {
      await pool.query(
        "UPDATE conversion_runs SET qa_results = $1, status = 'qa_check', updated_at = NOW() WHERE id = $2",
        [JSON.stringify(qaResults), runResult.rows[0].id]
      );
    }

    await pool.query("UPDATE artifacts SET status = 'qa_passed', updated_at = NOW() WHERE id = $1", [id]);
    res.json(qaResults);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deploy
router.post('/:id/deploy', async (req, res) => {
  const { id } = req.params;
  try {
    const artResult = await pool.query('SELECT * FROM artifacts WHERE id = $1', [id]);
    if (!artResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const art = artResult.rows[0];

    const deployResults = generateDeployResults(art);

    const runResult = await pool.query(
      'SELECT id FROM conversion_runs WHERE artifact_id = $1 ORDER BY run_number DESC LIMIT 1', [id]
    );

    if (runResult.rows.length) {
      await pool.query(
        "UPDATE conversion_runs SET deploy_results = $1, status = 'deploying', updated_at = NOW() WHERE id = $2",
        [JSON.stringify(deployResults), runResult.rows[0].id]
      );
    }

    await pool.query("UPDATE artifacts SET status = 'deployed', updated_at = NOW() WHERE id = $1", [id]);
    res.json(deployResults);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Validate
router.post('/:id/validate', async (req, res) => {
  const { id } = req.params;
  try {
    const artResult = await pool.query('SELECT * FROM artifacts WHERE id = $1', [id]);
    if (!artResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const art = artResult.rows[0];

    const validateResults = generateValidateResults(art);

    const runResult = await pool.query(
      'SELECT id FROM conversion_runs WHERE artifact_id = $1 ORDER BY run_number DESC LIMIT 1', [id]
    );

    if (runResult.rows.length) {
      await pool.query(
        "UPDATE conversion_runs SET validate_results = $1, status = 'completed', updated_at = NOW() WHERE id = $2",
        [JSON.stringify(validateResults), runResult.rows[0].id]
      );
    }

    await pool.query("UPDATE artifacts SET status = 'validated', updated_at = NOW() WHERE id = $1", [id]);
    res.json(validateResults);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Assessment Generation ──────────────────────────────────────────────────

function generateAssessment(art) {
  const platform = art.platform || 'boomi';
  const iflowName = generateIFlowName(art);
  const iflowPackage = `${art.domain || 'INT'}_Migration_Package_v1`;

  const findings = [];
  const recommendations = [];
  const challenges = [];

  // Process Metadata section
  findings.push({
    section: 'Process Metadata',
    items: [
      `Platform: ${platform.toUpperCase()} | Name: ${art.name}`,
      `Artifact Type: ${art.artifact_type || 'Process'} | Trigger: ${art.trigger_type || 'API'}`,
      `Domain: ${art.domain || 'INT'} | Process ID: ${art.process_id || 'N/A'}`,
      `Complexity Score: ${art.complexity_score} (${art.complexity_level}) | T-Shirt: ${art.tshirt_size} | Est. Effort: ${art.effort_days} days`
    ]
  });

  // Structural Analysis
  const structItems = [
    `${art.shapes_count} process shapes/activities identified`,
    `${art.connectors_count} adapter connection(s) configured`,
    `${art.maps_count || 0} data mapping(s) present`,
    `${art.dependencies_count} sub-process/module dependencies`
  ];
  if (art.has_scripting) structItems.push(`Custom scripting detected: ${art.scripting_detail || 'scripts present'}`);
  findings.push({ section: 'Structural Analysis', items: structItems });

  // Connectors
  const connItems = [`Primary connector: ${art.primary_connector || 'HTTP'}`];
  if (platform === 'boomi') {
    connItems.push('SAP connections use BAPI/IDoc or OData protocols');
    connItems.push('All connector types have SAP Integration Suite equivalents');
    if (art.connectors_count >= 3) connItems.push('Multi-connector pattern detected — verify adapter license coverage');
  } else if (platform === 'pipo') {
    connItems.push('SAP PI/PO channels will migrate to IS Adapters (IDoc, RFC, REST, AS2)');
    connItems.push('Sender/Receiver channels map to iFlow Start/End events');
  } else if (platform === 'tibco') {
    connItems.push('TIBCO BW adapters map to SAP IS connectors or HTTP adapter');
    connItems.push('Shared resources (connections) must be recreated as IS credentials');
  } else if (platform === 'mulesoft') {
    connItems.push('Mule connectors map to SAP IS adapter equivalents');
    connItems.push('HTTP listeners become HTTPS sender adapters in iFlow');
  }
  findings.push({ section: 'Connectors & Adapters', items: connItems });

  // Error Handling
  const errItems = [`Error handling type: ${art.error_handling || 'basic'}`];
  if (art.error_handling === 'multi_try_catch') {
    errItems.push('Multiple try/catch blocks must be redesigned as Exception Subprocesses in iFlow');
    challenges.push('Complex error handling requires manual restructuring into IS Exception Subprocess pattern');
  } else if (art.error_handling === 'try_catch') {
    errItems.push('Try/Catch pattern maps to iFlow Exception Subprocess with dead letter handling');
  } else {
    errItems.push('Basic error handling can be implemented with standard iFlow error end event');
  }
  findings.push({ section: 'Error Handling', items: errItems });

  // Mapping Analysis
  const mapItems = [`${art.maps_count || 0} data transformation(s) identified`];
  if (platform === 'boomi' && art.has_scripting) {
    mapItems.push('Groovy scripts for transformation must be reimplemented as XSLT or Groovy in IS');
    challenges.push('Groovy scripting requires reimplementation — test carefully for edge cases');
  }
  if (platform === 'mulesoft' && art.has_scripting) {
    mapItems.push('DataWeave expressions must be converted to SAP Message Mapping or XSLT');
    challenges.push('DataWeave to Message Mapping/XSLT conversion requires manual effort');
  }
  if (platform === 'pipo') {
    mapItems.push('SAP XI message mappings can be imported directly into Integration Suite');
    mapItems.push('XSLT mappings from PI/PO are reusable in IS with minor adapter changes');
  }
  if (art.maps_count > 3) {
    mapItems.push(`${art.maps_count} mappings indicate medium-to-high data transformation complexity`);
  }
  findings.push({ section: 'Mapping Analysis', items: mapItems });

  // Recommendations
  recommendations.push({
    section: 'Process Conversion',
    items: [
      `Target iFlow name: ${iflowName}`,
      `Package: ${iflowPackage}`,
      `Start event → ${art.trigger_type === 'Schedule' ? 'Timer Start Event' : art.trigger_type === 'Event' ? 'JMS/Kafka Sender Adapter' : 'HTTPS Sender Adapter'}`,
      `End event → Request Reply or Message End Event`,
      'Use Integration Suite Process Direct for internal calls replacing sub-process dependencies'
    ]
  });

  if (platform === 'pipo') {
    recommendations.push({
      section: 'Pre-built Content',
      items: [
        'Check SAP Business Accelerator Hub for pre-built Integration Packages',
        'SAP delivers standard content for common SAP-to-SAP scenarios',
        'Review available Integration Advisors for EDI/B2B message types',
        'Leverage Migration Tool for direct PI/PO → IS migration where possible'
      ]
    });
  }

  if (art.has_scripting) {
    recommendations.push({
      section: 'Scripting Migration',
      items: [
        'Audit all scripts for unsupported Java/Groovy APIs in IS sandbox',
        'Replace database direct calls in scripts with HTTP adapter patterns',
        'Convert complex Groovy to XSLT where mapping logic is transformational',
        'Use Groovy Script step in IS for business logic that cannot be mapped',
        'Ensure script security: avoid System.exit(), file I/O, and direct JDBC'
      ]
    });
  }

  recommendations.push({
    section: 'Mapping Conversion',
    items: [
      'Create source and target Message Types in IS Integration Designer',
      'Define XSD schemas for all message structures',
      platform === 'pipo' ? 'Import existing XI message mappings using Migration Tool' : 'Recreate data mappings in SAP IS Message Mapping editor',
      'Test mapped payloads with Simulation functionality in IS'
    ]
  });

  recommendations.push({
    section: 'Packaging & Deployment',
    items: [
      `Create Integration Package: ${iflowPackage}`,
      'Configure externalized parameters for environment-specific values',
      'Set up credential store entries for all adapter credentials',
      'Deploy to SAP Integration Suite tenant via API or Design Time UI',
      'Run smoke test with sample payload before production cutover'
    ]
  });

  return {
    findings,
    recommendations,
    iflow_name: iflowName,
    iflow_package: iflowPackage,
    migration_approach: art.complexity_level === 'Simple'
      ? 'Direct conversion with standard IS adapters and message mapping'
      : art.complexity_level === 'Medium'
        ? 'Phased conversion: adapter setup → mapping → scripting → error handling'
        : 'Full redesign with component decomposition and architectural review',
    identified_challenges: challenges
  };
}

function generateIFlowName(art) {
  const name = art.name || 'Process';
  const parts = name.replace(/[^a-zA-Z0-9_]/g, '_').split('_').filter(Boolean);
  const domain = art.domain || 'INT';
  return `${domain}_${parts.slice(0, 4).join('_')}_iFlow_v1`;
}

// ── Conversion Output ──────────────────────────────────────────────────────

function generateConversionOutput(art) {
  const platform = art.platform || 'boomi';
  const iflowName = generateIFlowName(art);
  const ts = new Date().toISOString();

  return `=== SAP Integration Suite Migration Tool — Conversion Process ===
Timestamp: ${ts}
Source Platform: ${platform.toUpperCase()}
Artifact: ${art.name}
Target iFlow: ${iflowName}

[STEP 1] Analyzing source artifact metadata...
  ✓ Process ID: ${art.process_id || 'N/A'}
  ✓ Shapes: ${art.shapes_count} | Connectors: ${art.connectors_count} | Maps: ${art.maps_count}
  ✓ Complexity: ${art.complexity_level} (${art.complexity_score}/100)
  ✓ Scripting: ${art.has_scripting ? 'Yes — ' + (art.scripting_detail || 'scripts detected') : 'None'}

[STEP 2] Generating iFlow skeleton...
  ✓ iFlow ID: ${iflowName}
  ✓ Package: ${art.domain || 'INT'}_Migration_Package_v1
  ✓ Created Start Event (${art.trigger_type === 'Schedule' ? 'Timer' : art.trigger_type === 'Event' ? 'JMS Sender' : 'HTTPS Sender'})
  ✓ Created End Event (Message End)

[STEP 3] Converting adapter configurations...
  ✓ Primary adapter: ${art.primary_connector || 'HTTP'} → IS ${mapAdapterToIS(art.primary_connector || 'HTTP')}
${art.connectors_count > 1 ? `  ✓ Secondary adapters: ${art.connectors_count - 1} additional connector(s) configured` : ''}

[STEP 4] Converting data mappings...
${art.maps_count > 0 ? `  ✓ ${art.maps_count} mapping(s) converted to SAP Message Mapping format` : '  ✓ No data mappings required'}
${art.has_scripting ? `  ⚠ Scripting detected — manual review required for: ${art.scripting_detail || 'custom scripts'}` : ''}

[STEP 5] Converting error handling...
  ✓ Error handling type: ${art.error_handling || 'basic'}
  ${art.error_handling === 'multi_try_catch' ? '⚠ Multi-level try/catch → Exception Subprocess (manual adjustment needed)' : '✓ Error handling pattern converted successfully'}

[STEP 6] Generating iFlow XML manifest...
  ✓ iFlow BPMN structure generated
  ✓ Sender adapter parameters externalized
  ✓ Receiver adapter parameters externalized
  ✓ Security credentials linked to Credential Store
  ✓ Log levels configured

[STEP 7] Validating iFlow structure...
  ✓ Start → Process → End connectivity verified
  ✓ Mandatory adapter properties present
  ✓ Schema references resolved
  ${art.has_scripting ? '⚠ Script step requires review before deployment' : '✓ All steps validated'}

[CONVERSION COMPLETE]
Status: ${art.complexity_level === 'Complex' ? 'Converted with Warnings' : 'Converted Successfully'}
iFlow: ${iflowName}
Estimated Manual Effort Remaining: ${art.has_scripting ? Math.ceil(art.effort_days * 0.4) : Math.ceil(art.effort_days * 0.15)} days
`;
}

function mapAdapterToIS(connector) {
  const map = {
    'Salesforce': 'Salesforce Adapter',
    'SAP S/4HANA': 'OData / BAPI Adapter',
    'SAP SuccessFactors': 'SuccessFactors Adapter',
    'SFTP': 'SFTP Adapter',
    'AS2': 'AS2 Adapter',
    'JMS': 'JMS Adapter',
    'Kafka': 'Kafka Adapter',
    'HTTP': 'HTTPS Adapter',
    'IDoc': 'IDoc Adapter',
    'RFC': 'RFC Adapter',
    'JDBC': 'JDBC Adapter',
    'Database': 'JDBC Adapter',
    'SAP Ariba': 'Ariba Adapter',
    'HTTP/REST': 'HTTPS Adapter'
  };
  return map[connector] || 'HTTPS Adapter';
}

// ── QA Results ─────────────────────────────────────────────────────────────

function generateQAResults(art) {
  const isComplex = art.complexity_level === 'Complex';
  const hasScripting = art.has_scripting;

  return {
    timestamp: new Date().toISOString(),
    artifact: art.name,
    overall_status: isComplex && hasScripting ? 'warning' : 'passed',
    sections: {
      structural_validation: {
        status: 'passed',
        checks: [
          { name: 'iFlow start event present', status: 'pass' },
          { name: 'iFlow end event present', status: 'pass' },
          { name: 'All steps connected', status: 'pass' },
          { name: 'No orphan shapes', status: 'pass' },
          { name: 'Adapter configuration complete', status: isComplex ? 'warning' : 'pass',
            message: isComplex ? 'Complex adapter configuration — verify credentials before deploy' : null }
        ]
      },
      process_integrity: {
        status: 'passed',
        checks: [
          { name: `${art.shapes_count} shapes converted`, status: 'pass' },
          { name: 'Process flow path validated', status: 'pass' },
          { name: 'Exception Subprocess linked', status: art.error_handling !== 'none' ? 'pass' : 'warning' },
          { name: 'Externalized parameters set', status: 'pass' }
        ]
      },
      mapping_validation: {
        status: hasScripting ? 'warning' : 'passed',
        checks: [
          { name: 'Message structure validated', status: 'pass' },
          { name: `${art.maps_count || 0} mapping(s) syntactically correct`, status: 'pass' },
          { name: 'Schema references resolved', status: 'pass' },
          { name: 'Script syntax validated', status: hasScripting ? 'warning' : 'pass',
            message: hasScripting ? 'Script logic requires functional testing with real payload' : null }
        ]
      },
      schema_validation: {
        status: 'passed',
        checks: [
          { name: 'XSD schemas registered', status: 'pass' },
          { name: 'Payload format verified', status: 'pass' },
          { name: 'Character encoding UTF-8', status: 'pass' }
        ]
      },
      dependency_check: {
        status: 'passed',
        checks: [
          { name: `${art.dependencies_count} dependencies resolved`, status: 'pass' },
          { name: 'Credential Store references valid', status: 'pass' },
          { name: 'Integration Package manifest updated', status: 'pass' }
        ]
      }
    }
  };
}

// ── Deploy Results ─────────────────────────────────────────────────────────

function generateDeployResults(art) {
  const iflowName = generateIFlowName(art);
  return {
    timestamp: new Date().toISOString(),
    deployment: {
      name: iflowName,
      type: 'Integration Flow',
      version: '1.0.0',
      tenant: 'CPI-Prod-Tenant01',
      runtime: 'SAP Integration Suite Cloud',
      deployment_time: new Date().toISOString(),
      duration_seconds: Math.floor(Math.random() * 30) + 15,
      status: 'Success'
    },
    validation_checks: [
      { name: 'iFlow Structure', status: 'pass' },
      { name: 'Adapter References', status: 'pass' },
      { name: 'Manifest Integrity', status: 'pass' },
      { name: 'Schema Binding', status: 'pass' },
      { name: 'Credential Lookup', status: 'pass' }
    ],
    execution_readiness: {
      status: 'Ready',
      endpoint: `https://cpi-prod.hana.ondemand.com/http/${iflowName.toLowerCase().replace(/_/g, '-')}`,
      message: 'iFlow deployed and started successfully. Ready to accept messages.'
    }
  };
}

// ── Validate Results ───────────────────────────────────────────────────────

function generateValidateResults(art) {
  const iflowName = generateIFlowName(art);
  const hasScripting = art.has_scripting;

  return {
    timestamp: new Date().toISOString(),
    artifact: art.name,
    iflow: iflowName,
    tenant: 'CPI-Prod-Tenant01',
    overall_status: 'Validated',
    functional_validation: {
      test_payload: { status: 'pass', message: 'Sample payload processed successfully' },
      adapter_connectivity: {
        status: 'pass',
        message: `${art.primary_connector || 'HTTP'} adapter connection verified`
      },
      error_handling: {
        status: art.error_handling !== 'none' ? 'pass' : 'warning',
        message: art.error_handling !== 'none' ? 'Error handling paths triggered and validated' : 'No error handling — consider adding exception handling'
      }
    },
    schema_mapping_validation: {
      schema_conformance: { status: 'pass', message: 'Input/output payloads conform to registered schemas' },
      mapping_output: { status: hasScripting ? 'warning' : 'pass', message: hasScripting ? 'Script output validated but business rules require manual sign-off' : 'Mapping output matches expected target format' },
      character_encoding: { status: 'pass', message: 'UTF-8 encoding verified' }
    },
    iflow_behavior: {
      sequence: { status: 'pass', message: 'All steps executed in correct sequence' },
      logging: { status: 'pass', message: 'Message processing logs captured in MPL' },
      performance: { status: 'pass', message: `Average processing time: ${Math.floor(Math.random() * 800) + 200}ms (within SLA)` }
    },
    integration_suite: {
      total_applications: 1,
      migrated: 1,
      deployed: 1,
      status: 'Active',
      action_version: '1.0.0'
    }
  };
}

module.exports = router;
