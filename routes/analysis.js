const express = require('express');
const router = express.Router();
const { pool } = require('../database/db');

// ── Complexity Scoring Engine ──────────────────────────────────────────────

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

// GET /api/analysis/artifact/:id — per-artifact score breakdown
router.get('/artifact/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM artifacts WHERE id = $1', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    const art = result.rows[0];

    const errorLevelMap = { none: 0, basic: 1, try_catch: 2, multi_try_catch: 3 };
    const scriptingLevel = art.has_scripting ? 2 : 0;
    const errorLevel = errorLevelMap[art.error_handling] || 1;

    const breakdown = {
      shapes: { value: art.shapes_count, raw: computeRawScore('shapes', art.shapes_count), weight: 1.5 },
      connectors: { value: art.connectors_count, raw: computeRawScore('connectors', art.connectors_count), weight: 2.0 },
      maps: { value: art.maps_count, raw: computeRawScore('maps', art.maps_count || 0), weight: 2.5 },
      scripting: { value: scriptingLevel, raw: computeRawScore('scripting', scriptingLevel), weight: 2.0 },
      error_handling: { value: errorLevel, raw: computeRawScore('error_handling', errorLevel), weight: 1.0 },
      dependencies: { value: art.dependencies_count, raw: computeRawScore('dependencies', art.dependencies_count), weight: 1.0 }
    };

    const score = art.complexity_score;
    const classification = classifyComplexity(score);

    res.json({
      artifact_id: art.id,
      name: art.name,
      platform: art.platform,
      score,
      level: classification.level,
      tshirt: classification.tshirt,
      effort_days: classification.effort,
      breakdown,
      readiness: art.readiness
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analysis/project/:id — full project analysis report
router.get('/project/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [project, artifacts] = await Promise.all([
      pool.query('SELECT * FROM projects WHERE id = $1', [id]),
      pool.query('SELECT * FROM artifacts WHERE project_id = $1', [id])
    ]);

    if (!project.rows.length) return res.status(404).json({ error: 'Project not found' });

    const analysis = buildProjectAnalysis(project.rows[0], artifacts.rows);

    // Upsert project analysis
    const existing = await pool.query('SELECT id FROM project_analysis WHERE project_id = $1', [id]);
    if (existing.rows.length) {
      await pool.query(
        `UPDATE project_analysis SET
          total_processes = $1, simple_count = $2, medium_count = $3, complex_count = $4,
          total_effort_days = $5, migration_duration_months = $6, complexity_distribution = $7,
          connector_summary = $8, domain_summary = $9, risks = $10, recommendations = $11, roadmap = $12,
          updated_at = NOW()
         WHERE project_id = $13`,
        [analysis.total_processes, analysis.simple_count, analysis.medium_count, analysis.complex_count,
         analysis.total_effort_days, analysis.migration_duration_months,
         JSON.stringify(analysis.complexity_distribution), JSON.stringify(analysis.connector_summary),
         JSON.stringify(analysis.domain_summary), JSON.stringify(analysis.risks),
         JSON.stringify(analysis.recommendations), JSON.stringify(analysis.roadmap), id]
      );
    } else {
      await pool.query(
        `INSERT INTO project_analysis
          (project_id, total_processes, simple_count, medium_count, complex_count,
           total_effort_days, migration_duration_months, complexity_distribution,
           connector_summary, domain_summary, risks, recommendations, roadmap)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, analysis.total_processes, analysis.simple_count, analysis.medium_count, analysis.complex_count,
         analysis.total_effort_days, analysis.migration_duration_months,
         JSON.stringify(analysis.complexity_distribution), JSON.stringify(analysis.connector_summary),
         JSON.stringify(analysis.domain_summary), JSON.stringify(analysis.risks),
         JSON.stringify(analysis.recommendations), JSON.stringify(analysis.roadmap)]
      );
    }

    res.json({ project: project.rows[0], analysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/analysis/project/:id/run — re-analyze all artifacts
router.post('/project/:id/run', async (req, res) => {
  try {
    const { id } = req.params;
    const artifacts = await pool.query('SELECT * FROM artifacts WHERE project_id = $1', [id]);

    let updated = 0;
    for (const art of artifacts.rows) {
      const errorLevelMap = { none: 0, basic: 1, try_catch: 2, multi_try_catch: 3 };
      const errorLevel = errorLevelMap[art.error_handling] || 1;
      const scriptingLevel = art.has_scripting ? 2 : 0;

      const newScore = computeComplexityScore({
        shapes_count: art.shapes_count,
        connectors_count: art.connectors_count,
        maps_complexity: art.maps_count > 3 ? 3 : (art.maps_count > 1 ? 2 : (art.maps_count > 0 ? 1 : 0)),
        scripting_level: scriptingLevel,
        error_handling_level: errorLevel,
        dependencies_count: art.dependencies_count
      });
      const classification = classifyComplexity(newScore);

      await pool.query(
        `UPDATE artifacts SET complexity_score = $1, complexity_level = $2, tshirt_size = $3, effort_days = $4, updated_at = NOW() WHERE id = $5`,
        [newScore, classification.level, classification.tshirt, classification.effort, art.id]
      );
      updated++;
    }

    res.json({ success: true, artifacts_reanalyzed: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function buildProjectAnalysis(project, artifacts) {
  const total = artifacts.length;
  const simpleCount = artifacts.filter(a => a.complexity_level === 'Simple').length;
  const mediumCount = artifacts.filter(a => a.complexity_level === 'Medium').length;
  const complexCount = artifacts.filter(a => a.complexity_level === 'Complex').length;
  const totalEffort = artifacts.reduce((sum, a) => sum + (parseInt(a.effort_days) || 0), 0);

  // Migration duration: parallel teams assumption (3 parallel streams, sprint = 10 days)
  const sprints = Math.ceil(totalEffort / (3 * 10));
  const migrationMonths = Math.max(2, Math.ceil(sprints * 0.5));

  // Complexity distribution
  const complexityDistribution = {
    Simple: { count: simpleCount, pct: total > 0 ? Math.round((simpleCount / total) * 100) : 0 },
    Medium: { count: mediumCount, pct: total > 0 ? Math.round((mediumCount / total) * 100) : 0 },
    Complex: { count: complexCount, pct: total > 0 ? Math.round((complexCount / total) * 100) : 0 }
  };

  // Connector summary
  const connectorMap = {};
  for (const art of artifacts) {
    const conn = art.primary_connector || 'HTTP';
    connectorMap[conn] = (connectorMap[conn] || 0) + 1;
  }
  const connectorSummary = Object.entries(connectorMap)
    .map(([name, count]) => ({ name, count, pct: Math.round((count / total) * 100) }))
    .sort((a, b) => b.count - a.count);

  // Domain summary
  const domainMap = {};
  for (const art of artifacts) {
    const domain = art.domain || 'INT';
    if (!domainMap[domain]) domainMap[domain] = { count: 0, effort: 0, simple: 0, medium: 0, complex: 0 };
    domainMap[domain].count++;
    domainMap[domain].effort += parseInt(art.effort_days) || 0;
    if (art.complexity_level === 'Simple') domainMap[domain].simple++;
    else if (art.complexity_level === 'Medium') domainMap[domain].medium++;
    else domainMap[domain].complex++;
  }
  const domainSummary = Object.entries(domainMap)
    .map(([domain, data]) => ({ domain, ...data }))
    .sort((a, b) => b.count - a.count);

  // Risks
  const risks = [];
  if (complexCount > 0) {
    risks.push({ severity: 'High', description: `${complexCount} complex artifacts require extended effort and architectural review`, mitigation: 'Assign senior architects to complex artifact migration; plan dedicated sprints' });
  }
  const scriptingArtifacts = artifacts.filter(a => a.has_scripting).length;
  if (scriptingArtifacts > 0) {
    risks.push({ severity: 'Medium', description: `${scriptingArtifacts} artifacts contain custom scripting (Groovy/DataWeave) requiring manual reimplementation`, mitigation: 'Script audit in Sprint 1; allocate 20% buffer for script conversion effort' });
  }
  if (mediumCount > total * 0.5) {
    risks.push({ severity: 'Medium', description: 'High proportion of medium complexity artifacts may cause schedule slippage', mitigation: 'Batch medium artifacts with shared patterns; reuse mapping templates across similar interfaces' });
  }
  risks.push({ severity: 'Low', description: 'SAP Integration Suite license model may require additional adapter packs for non-standard connectors', mitigation: 'Validate connector coverage with SAP account team before project kickoff' });

  // Recommendations
  const recommendations = [
    { priority: 1, area: 'Foundation', text: 'Set up SAP Integration Suite tenant and configure basic connectivity before migration begins' },
    { priority: 2, area: 'Tooling', text: 'Use SAP Integration Suite Migration Tool for automated PI/PO scenario migration where applicable' },
    { priority: 3, area: 'Packaging', text: 'Organize iFlows into domain-based Integration Packages matching existing business domains' },
    { priority: 4, area: 'Testing', text: 'Implement end-to-end test scenarios in non-production IS tenant before production cutover' },
    { priority: 5, area: 'Governance', text: 'Establish naming conventions for iFlows, packages, and externalized parameters' }
  ];

  // Migration Roadmap
  const roadmap = buildRoadmap(simpleCount, mediumCount, complexCount, totalEffort, migrationMonths);

  return {
    total_processes: total,
    simple_count: simpleCount,
    medium_count: mediumCount,
    complex_count: complexCount,
    total_effort_days: totalEffort,
    migration_duration_months: migrationMonths,
    complexity_distribution: complexityDistribution,
    connector_summary: connectorSummary,
    domain_summary: domainSummary,
    risks,
    recommendations,
    roadmap
  };
}

function buildRoadmap(simple, medium, complex, totalEffort, months) {
  const phases = [];

  phases.push({
    phase: 1,
    name: 'Foundation & Setup',
    duration: '2 weeks',
    activities: [
      'Provision SAP Integration Suite tenant',
      'Configure integration with source system landscapes',
      'Define naming conventions and governance standards',
      'Set up CI/CD pipeline for iFlow deployment',
      'Run Migration Assessment Tool and validate findings'
    ]
  });

  if (simple > 0) {
    phases.push({
      phase: 2,
      name: `Simple Artifacts Migration (${simple} iFlows)`,
      duration: `${Math.ceil(simple / 5)} sprints`,
      activities: [
        `Convert ${simple} simple artifacts (XS/S tier)`,
        'Use standard IS adapters and basic message mapping',
        'Validate each iFlow with unit test payload',
        'Deploy to dev/test IS tenant for integration testing'
      ]
    });
  }

  if (medium > 0) {
    phases.push({
      phase: 3,
      name: `Medium Complexity Migration (${medium} iFlows)`,
      duration: `${Math.ceil(medium / 3)} sprints`,
      activities: [
        `Convert ${medium} medium complexity artifacts (M tier)`,
        'Implement multi-connector iFlow patterns',
        'Create reusable mapping libraries',
        'Exception subprocess design and testing'
      ]
    });
  }

  if (complex > 0) {
    phases.push({
      phase: 4,
      name: `Complex Artifact Migration (${complex} iFlows)`,
      duration: `${Math.ceil(complex / 2)} sprints`,
      activities: [
        `Architect and convert ${complex} complex artifacts (L/XL tier)`,
        'Script reimplementation and optimization',
        'EDI/B2B configuration with Integration Advisor',
        'Performance testing under load'
      ]
    });
  }

  phases.push({
    phase: phases.length + 1,
    name: 'UAT & Production Cutover',
    duration: '3 weeks',
    activities: [
      'User acceptance testing with business stakeholders',
      'Performance benchmarking vs original platform',
      'Cutover planning and rollback strategy documentation',
      'Production deployment and hypercare monitoring',
      'Decommission source integration platform'
    ]
  });

  return phases;
}

// GET /api/analysis/project/:id/roi — ROI model data
router.get('/project/:id/roi', async (req, res) => {
  try {
    const { id } = req.params;
    const { dayRate = 1500, uplift = 30, teams = 3, hypercare = 4,
            legacyLicense = 250000, sapLicense = 180000,
            legacyFtes = 3, sapFtes = 1.5, fteCost = 120000, horizon = 5 } = req.query;

    const [project, artifacts] = await Promise.all([
      pool.query('SELECT * FROM projects WHERE id = $1', [id]),
      pool.query('SELECT effort_days FROM artifacts WHERE project_id = $1', [id])
    ]);
    if (!project.rows.length) return res.status(404).json({ error: 'Not found' });

    const effortDays   = artifacts.rows.reduce((s, a) => s + (parseInt(a.effort_days) || 0), 0);
    const baseCost     = effortDays * parseFloat(dayRate);
    const migrationCost = baseCost * (1 + parseFloat(uplift) / 100) + parseFloat(hypercare) * parseFloat(teams) * parseFloat(dayRate) * 5;
    const annualSaving  = (parseFloat(legacyLicense) - parseFloat(sapLicense)) + (parseFloat(legacyFtes) - parseFloat(sapFtes)) * parseFloat(fteCost);
    const payback       = annualSaving > 0 ? migrationCost / annualSaving : null;
    const roi           = migrationCost > 0 ? ((annualSaving * parseFloat(horizon) - migrationCost) / migrationCost) * 100 : 0;

    const r = 0.08;
    let npv = -migrationCost;
    for (let y = 1; y <= parseFloat(horizon); y++) npv += annualSaving / Math.pow(1 + r, y);

    res.json({
      project: project.rows[0],
      inputs: { effortDays, dayRate, uplift, teams, hypercare, legacyLicense, sapLicense, legacyFtes, sapFtes, fteCost, horizon },
      results: { migrationCost: Math.round(migrationCost), annualSaving: Math.round(annualSaving), paybackYears: payback ? Math.round(payback * 10) / 10 : null, roi: Math.round(roi), npv: Math.round(npv) }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
