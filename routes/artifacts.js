/**
 * Artifacts Routes — Sprint 1 Enhanced
 * All workflow steps now use the platform connector + engine layer.
 * Mock/real switching is automatic via connector factory.
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../database/db');
const { getConnector } = require('../connectors');
const { runAssessment } = require('../engine/assessment');
const { runConversion } = require('../engine/conversion');
const { runQA } = require('../engine/qa');
const { runDeploy } = require('../engine/deploy');
const { runValidate } = require('../engine/validate');
const { generateIFlowPackage } = require('../engine/iflow');
const { runQualityAnalysis } = require('../engine/quality');
const { extractMuleSoftPlatformData, buildGroovyFromDataWeave } = require('../services/iflow-generator-mulesoft');
const { extractBw6PlatformData } = require('../services/iflow-generator-tibco-bw6');
const { extractBw5PlatformData } = require('../services/iflow-generator-tibco-bw5');

// ── Resolve real platform data: prefer raw_xml extraction over mock connector ─
async function resolvePlatformData(art) {
  if (art.raw_xml && art.platform === 'mulesoft') {
    const real = await extractMuleSoftPlatformData(art);
    real._source = real._source || 'raw_xml';
    return real;
  }
  // BW6: platform='tibco', artifact_type='BW6Process'
  if (art.raw_xml && art.platform === 'tibco' && art.artifact_type === 'BW6Process') {
    const real = await extractBw6PlatformData(art);
    real._source = real._source || 'raw_xml_bw6';
    return real;
  }
  // BW5: platform='tibco', artifact_type='ProcessDef'
  if (art.raw_xml && art.platform === 'tibco' && art.artifact_type === 'ProcessDef') {
    const real = await extractBw5PlatformData(art);
    real._source = real._source || 'raw_xml_bw5';
    return real;
  }
  const connector = getConnector(art.platform || art.project_platform);
  return connector.getArtifactData(art);
}

// ── List artifacts for a project ──────────────────────────────────────────────
router.get('/project/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { status, complexity, domain, platform, source_id } = req.query;

    let conditions = ['a.project_id = $1'];
    const params = [projectId];
    let paramIdx = 2;

    if (status)     { conditions.push(`a.status = $${paramIdx++}`);           params.push(status); }
    if (complexity) { conditions.push(`a.complexity_level = $${paramIdx++}`); params.push(complexity); }
    if (domain)     { conditions.push(`a.domain = $${paramIdx++}`);           params.push(domain); }
    if (platform)   { conditions.push(`a.platform = $${paramIdx++}`);         params.push(platform); }
    if (source_id)  { conditions.push(`a.source_id = $${paramIdx++}`);        params.push(source_id); }

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

// ── Stats for project artifacts ───────────────────────────────────────────────
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
        COUNT(*) FILTER (WHERE status IN ('converted','qa_passed','deployed','validated')) AS converted_count,
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

// ── Get single artifact with assessment + runs ────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [artifact, assessment, runs] = await Promise.all([
      pool.query('SELECT a.*, sc.name AS source_name FROM artifacts a LEFT JOIN source_connections sc ON sc.id = a.source_id WHERE a.id = $1', [id]),
      pool.query('SELECT * FROM artifact_assessments WHERE artifact_id = $1', [id]),
      pool.query('SELECT * FROM conversion_runs WHERE artifact_id = $1 ORDER BY run_number DESC LIMIT 5', [id])
    ]);
    if (!artifact.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ...artifact.rows[0], assessment: assessment.rows[0] || null, runs: runs.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Update artifact ───────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { status, readiness, complexity_score, complexity_level, tshirt_size, effort_days } = req.body;
  try {
    const result = await pool.query(
      `UPDATE artifacts SET
        status = COALESCE($1, status), readiness = COALESCE($2, readiness),
        complexity_score = COALESCE($3, complexity_score), complexity_level = COALESCE($4, complexity_level),
        tshirt_size = COALESCE($5, tshirt_size), effort_days = COALESCE($6, effort_days),
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

// ── ASSESS ───────────────────────────────────────────────────────────────────
router.post('/:id/assess', async (req, res) => {
  const { id } = req.params;
  try {
    const artResult = await pool.query('SELECT a.*, p.platform AS project_platform FROM artifacts a LEFT JOIN projects p ON p.id = a.project_id WHERE a.id = $1', [id]);
    if (!artResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const art = artResult.rows[0];

    // Get platform data — real raw_xml extraction for MuleSoft, connector for others
    const platformData = await resolvePlatformData(art);

    // Backfill DB metadata counts from extracted platform data so assessment
    // findings show real numbers instead of 0 for freshly-seeded artifacts
    const processors  = platformData.processors  || platformData.activities || platformData.shapes || [];
    const xslts       = platformData.xsltTransforms || [];
    const scripts     = platformData.javaScripts || platformData.scripts || [];
    const connTypes   = platformData.connectorTypes || [];
    const recvCfgs    = platformData.receiverConfigs || [];
    const errorHandlers = platformData.errorHandlers || [];

    // Count xslt-type processors + standalone xsltTransforms + BW5 mappers for maps
    const mappers        = platformData.mappers || [];
    const xsltProcessors = processors.filter(p => p.type === 'xslt').length;
    const derivedShapes      = processors.length || art.shapes_count || 0;
    const derivedConnectors  = Math.max(connTypes.length, recvCfgs.length) || art.connectors_count || 0;
    const derivedMaps        = xsltProcessors + xslts.length + mappers.length || art.maps_count || 0;
    const derivedScripting   = scripts.length > 0 || art.has_scripting || false;
    const derivedDeps        = errorHandlers.length || art.dependencies_count || 0;

    // Derive complexity score from real data (0–100)
    const derivedComplexity  = Math.min(100, Math.round(
      (derivedShapes * 4) +
      (derivedConnectors * 8) +
      (derivedMaps * 6) +
      (scripts.length * 10) +
      (errorHandlers.length * 5)
    ));
    const derivedLevel = derivedComplexity >= 70 ? 'High' :
                         derivedComplexity >= 40 ? 'Medium' : 'Low';
    const derivedTshirt = derivedComplexity >= 70 ? 'XL' :
                          derivedComplexity >= 40 ? 'L' :
                          derivedComplexity >= 20 ? 'M' : 'S';
    const derivedEffort = derivedComplexity >= 70 ? 10 :
                          derivedComplexity >= 40 ? 5 :
                          derivedComplexity >= 20 ? 3 : 1;

    // Error handling pattern from platformData
    const errorPattern = errorHandlers.length > 0
      ? (errorHandlers.some(e => e.type === 'catchAll') ? 'Catch-All + Specific Faults' : 'Specific Fault Handlers')
      : (art.error_handling || null);

    await pool.query(
      `UPDATE artifacts SET
        shapes_count=$1, connectors_count=$2, maps_count=$3,
        has_scripting=$4, primary_connector=$5,
        complexity_score=$6, complexity_level=$7, tshirt_size=$8, effort_days=$9,
        dependencies_count=$10, error_handling=$11,
        updated_at=NOW() WHERE id=$12`,
      [derivedShapes, derivedConnectors, derivedMaps, derivedScripting,
       connTypes[0] || art.primary_connector || 'HTTP',
       derivedComplexity, derivedLevel, derivedTshirt, derivedEffort,
       derivedDeps, errorPattern, id]
    );
    // Reflect in local art object so assessment uses the real numbers
    art.shapes_count      = derivedShapes;
    art.connectors_count  = derivedConnectors;
    art.maps_count        = derivedMaps;
    art.has_scripting     = derivedScripting;
    art.primary_connector = connTypes[0] || art.primary_connector || 'HTTP';
    art.complexity_score  = derivedComplexity;
    art.complexity_level  = derivedLevel;
    art.tshirt_size       = derivedTshirt;
    art.effort_days       = derivedEffort;
    art.dependencies_count = derivedDeps;
    art.error_handling    = errorPattern;

    // Run rich assessment engine
    const assessment = runAssessment(art, platformData);

    // Upsert into DB
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
         JSON.stringify(assessment.identified_challenges || []), id]
      );
    } else {
      result = await pool.query(
        `INSERT INTO artifact_assessments
          (artifact_id, findings, recommendations, iflow_name, iflow_package, migration_approach, identified_challenges)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, JSON.stringify(assessment.findings), JSON.stringify(assessment.recommendations),
         assessment.iflow_name, assessment.iflow_package, assessment.migration_approach,
         JSON.stringify(assessment.identified_challenges || [])]
      );
    }

    await pool.query("UPDATE artifacts SET status = 'assessed', updated_at = NOW() WHERE id = $1", [id]);

    // Return full assessment enriched with engine output
    res.json({
      ...result.rows[0],
      complexity_breakdown: assessment.complexity_breakdown,
      iflow_adapters: assessment.iflow_adapters,
      risk_items: assessment.risk_items,
      connector_mode: assessment.connector_mode,
      platform_data_source: assessment.platform_data_source
    });
  } catch (err) {
    console.error('Assessment error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── CONVERT ───────────────────────────────────────────────────────────────────
router.post('/:id/convert', async (req, res) => {
  const { id } = req.params;
  try {
    const artResult = await pool.query('SELECT a.*, p.platform AS project_platform FROM artifacts a LEFT JOIN projects p ON p.id = a.project_id WHERE a.id = $1', [id]);
    if (!artResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const art = artResult.rows[0];

    // Use real raw_xml extractor for MuleSoft; mock connector for others
    const platformData = await resolvePlatformData(art);
    const convOutput   = runConversion(art, platformData);

    // Generate the actual iFlow package to capture iflow_xml
    const pkg = generateIFlowPackage(art, platformData, convOutput);

    // Get next run number
    const runCount = await pool.query('SELECT COUNT(*) FROM conversion_runs WHERE artifact_id = $1', [id]);
    const runNumber = parseInt(runCount.rows[0].count) + 1;

    const runResult = await pool.query(
      `INSERT INTO conversion_runs (artifact_id, run_number, convert_output, status)
       VALUES ($1, $2, $3, 'converting') RETURNING *`,
      [id, runNumber, JSON.stringify(convOutput)]
    );

    // S10: Real quality analysis — completeness score, flags, readiness
    const quality    = runQualityAnalysis(art, platformData);
    const notes      = quality.flags;
    const completeness = quality.score;
    const readiness  = quality.readiness;
    const dataSource = platformData._source || 'connector';

    await pool.query("UPDATE conversion_runs SET status = 'converted', updated_at = NOW() WHERE id = $1", [runResult.rows[0].id]);
    await pool.query(
      `UPDATE artifacts SET
        status = 'converted',
        conversion_status = 'converted',
        converted_at = NOW(),
        iflow_xml = $1,
        conversion_notes = $2,
        conversion_completeness = $3,
        readiness = $4,
        updated_at = NOW()
       WHERE id = $5`,
      [convOutput.iflow_xml || null, JSON.stringify(notes), completeness, readiness, id]
    );
    await pool.query("UPDATE projects SET updated_at = NOW() WHERE id = (SELECT project_id FROM artifacts WHERE id = $1)", [id]);

    res.json({
      ...runResult.rows[0],
      status: 'converted',
      convert_output: convOutput,
      conversion_completeness: completeness,
      conversion_notes: notes,
      quality_summary: quality.summary,
      readiness,
      data_source: dataSource,
      iflow_id: pkg.iflowId,
      iflow_name: pkg.iflowName
    });
  } catch (err) {
    console.error('Conversion error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── QA ────────────────────────────────────────────────────────────────────────
router.post('/:id/qa', async (req, res) => {
  const { id } = req.params;
  try {
    const artResult = await pool.query('SELECT a.*, p.platform AS project_platform FROM artifacts a LEFT JOIN projects p ON p.id = a.project_id WHERE a.id = $1', [id]);
    if (!artResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const art = artResult.rows[0];

    const connector = getConnector(art.platform || art.project_platform);
    const platformData = await connector.getArtifactData(art);
    const qaResults = runQA(art, platformData);

    const runResult = await pool.query('SELECT id FROM conversion_runs WHERE artifact_id = $1 ORDER BY run_number DESC LIMIT 1', [id]);
    if (runResult.rows.length) {
      await pool.query("UPDATE conversion_runs SET qa_results = $1, status = 'qa_check', updated_at = NOW() WHERE id = $2", [JSON.stringify(qaResults), runResult.rows[0].id]);
    }

    await pool.query("UPDATE artifacts SET status = 'qa_passed', updated_at = NOW() WHERE id = $1", [id]);
    res.json(qaResults);
  } catch (err) {
    console.error('QA error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── DEPLOY ────────────────────────────────────────────────────────────────────
router.post('/:id/deploy', async (req, res) => {
  const { id } = req.params;
  try {
    const artResult = await pool.query('SELECT a.*, p.platform AS project_platform FROM artifacts a LEFT JOIN projects p ON p.id = a.project_id WHERE a.id = $1', [id]);
    if (!artResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const art = artResult.rows[0];

    const connector = getConnector(art.platform || art.project_platform);
    const platformData = await connector.getArtifactData(art);
    const deployResults = runDeploy(art, platformData);

    const runResult = await pool.query('SELECT id FROM conversion_runs WHERE artifact_id = $1 ORDER BY run_number DESC LIMIT 1', [id]);
    if (runResult.rows.length) {
      await pool.query("UPDATE conversion_runs SET deploy_results = $1, status = 'deploying', updated_at = NOW() WHERE id = $2", [JSON.stringify(deployResults), runResult.rows[0].id]);
    }

    await pool.query("UPDATE artifacts SET status = 'deployed', updated_at = NOW() WHERE id = $1", [id]);
    res.json(deployResults);
  } catch (err) {
    console.error('Deploy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── VALIDATE ──────────────────────────────────────────────────────────────────
router.post('/:id/validate', async (req, res) => {
  const { id } = req.params;
  try {
    const artResult = await pool.query('SELECT a.*, p.platform AS project_platform FROM artifacts a LEFT JOIN projects p ON p.id = a.project_id WHERE a.id = $1', [id]);
    if (!artResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const art = artResult.rows[0];

    const connector = getConnector(art.platform || art.project_platform);
    const platformData = await connector.getArtifactData(art);
    const validateResults = runValidate(art, platformData);

    const runResult = await pool.query('SELECT id FROM conversion_runs WHERE artifact_id = $1 ORDER BY run_number DESC LIMIT 1', [id]);
    if (runResult.rows.length) {
      await pool.query("UPDATE conversion_runs SET validate_results = $1, status = 'completed', updated_at = NOW() WHERE id = $2", [JSON.stringify(validateResults), runResult.rows[0].id]);
    }

    await pool.query("UPDATE artifacts SET status = 'validated', updated_at = NOW() WHERE id = $1", [id]);
    res.json(validateResults);
  } catch (err) {
    console.error('Validate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── DOWNLOAD iFlow Package ─────────────────────────────────────────────────────
router.get('/:id/download', async (req, res) => {
  const { id } = req.params;
  try {
    // Load artifact + platform data
    const artResult = await pool.query(
      'SELECT a.*, p.platform AS project_platform FROM artifacts a LEFT JOIN projects p ON p.id = a.project_id WHERE a.id = $1',
      [id]
    );
    if (!artResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const art = artResult.rows[0];

    // Load last conversion run output (for iflow_xml if available)
    const runResult = await pool.query(
      'SELECT convert_output FROM conversion_runs WHERE artifact_id = $1 ORDER BY run_number DESC LIMIT 1',
      [id]
    );
    const convOutput = runResult.rows.length ? runResult.rows[0].convert_output : null;

    // Use real raw_xml extraction for MuleSoft; connector for others
    const platformData = await resolvePlatformData(art);

    // Generate iFlow package ZIP
    const pkg = generateIFlowPackage(art, platformData, convOutput);

    // Stream as ZIP download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${pkg.filename}"`);
    res.setHeader('X-IFlow-Id', pkg.iflowId);
    res.setHeader('X-IFlow-Name', pkg.iflowName);
    res.setHeader('X-Package-Name', pkg.packageName);
    res.send(pkg.buffer);

  } catch (err) {
    console.error('iFlow download error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET raw source XML (for UI "View Source" button) ─────────────────────────
router.get('/:id/raw-xml', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT name, platform, raw_xml FROM artifacts WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { name, platform, raw_xml } = rows[0];
    if (!raw_xml) return res.json({ hasSource: false, message: 'No source XML stored — re-upload the file to capture raw source' });
    res.json({ hasSource: true, name, platform, xml: raw_xml, length: raw_xml.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET conversion notes for artifact ────────────────────────────────────────
router.get('/:id/conversion-report', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.name, a.platform, a.conversion_status, a.converted_at,
              a.conversion_completeness, a.conversion_notes, a.iflow_xml,
              cr.convert_output
       FROM artifacts a
       LEFT JOIN conversion_runs cr ON cr.artifact_id = a.id
       WHERE a.id = $1
       ORDER BY cr.run_number DESC
       LIMIT 1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
