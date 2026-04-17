const express = require('express');
const router = express.Router();
const { pool } = require('../database/db');
const AdmZip = require('adm-zip');
const { getConnector } = require('../connectors');
const { generateIFlowPackage, buildPackageName } = require('../engine/iflow');
const { generateHTMLReport } = require('../engine/pdf');

// List all projects with artifact counts
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*,
        COUNT(DISTINCT a.id)                                                    AS artifact_count,
        COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'converted')             AS converted_count,
        COUNT(DISTINCT a.id) FILTER (WHERE a.status IN ('deployed','validated')) AS deployed_count,
        COUNT(DISTINCT a.id) FILTER (WHERE a.readiness = 'Auto')               AS auto_count,
        COUNT(DISTINCT a.id) FILTER (WHERE a.readiness = 'Partial')            AS partial_count,
        COUNT(DISTINCT a.id) FILTER (WHERE a.readiness = 'Manual')             AS manual_count,
        COALESCE(SUM(a.effort_days),0)                                         AS total_effort_days,
        COUNT(DISTINCT a.id) FILTER (WHERE a.complexity_level = 'Simple')      AS simple_count,
        COUNT(DISTINCT a.id) FILTER (WHERE a.complexity_level = 'Medium')      AS medium_count,
        COUNT(DISTINCT a.id) FILTER (WHERE a.complexity_level = 'Complex')     AS complex_count
      FROM projects p
      LEFT JOIN artifacts a ON a.project_id = p.id
      GROUP BY p.id
      ORDER BY p.updated_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single project with stats
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [project, sources, stats] = await Promise.all([
      pool.query('SELECT * FROM projects WHERE id = $1', [id]),
      pool.query('SELECT * FROM source_connections WHERE project_id = $1 ORDER BY created_at DESC', [id]),
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE complexity_level = 'Simple') AS simple_count,
          COUNT(*) FILTER (WHERE complexity_level = 'Medium') AS medium_count,
          COUNT(*) FILTER (WHERE complexity_level = 'Complex') AS complex_count,
          COUNT(*) FILTER (WHERE status = 'converted') AS converted_count,
          COUNT(*) FILTER (WHERE status = 'deployed') AS deployed_count,
          COUNT(*) FILTER (WHERE status = 'validated') AS validated_count,
          COALESCE(SUM(effort_days), 0) AS total_effort_days
        FROM artifacts WHERE project_id = $1
      `, [id])
    ]);
    if (!project.rows.length) return res.status(404).json({ error: 'Project not found' });
    res.json({ ...project.rows[0], sources: sources.rows, stats: stats.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create project
router.post('/', async (req, res) => {
  const { name, customer, consultant, platform, description } = req.body;
  if (!name || !customer || !platform) return res.status(400).json({ error: 'name, customer, and platform are required' });
  try {
    const result = await pool.query(
      `INSERT INTO projects (name, customer, consultant, platform, description)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, customer, consultant || null, platform, description || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update project
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, customer, consultant, platform, description, status } = req.body;
  try {
    const result = await pool.query(
      `UPDATE projects SET
        name = COALESCE($1, name),
        customer = COALESCE($2, customer),
        consultant = COALESCE($3, consultant),
        platform = COALESCE($4, platform),
        description = COALESCE($5, description),
        status = COALESCE($6, status),
        updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [name, customer, consultant, platform, description, status, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete project
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HTML Assessment Report (opens in browser — use File > Print > Save as PDF) ──
router.get('/:id/report', async (req, res) => {
  try {
    const { id } = req.params;
    const [projRes, artRes, statsRes] = await Promise.all([
      pool.query('SELECT * FROM projects WHERE id = $1', [id]),
      pool.query('SELECT * FROM artifacts WHERE project_id = $1 ORDER BY complexity_score DESC', [id]),
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE complexity_level = 'Simple')  AS simple_count,
          COUNT(*) FILTER (WHERE complexity_level = 'Medium')  AS medium_count,
          COUNT(*) FILTER (WHERE complexity_level = 'Complex') AS complex_count,
          COUNT(*) FILTER (WHERE readiness = 'Auto')           AS auto_count,
          COUNT(*) FILTER (WHERE readiness = 'Partial')        AS partial_count,
          COUNT(*) FILTER (WHERE readiness = 'Manual')         AS manual_count,
          COALESCE(SUM(effort_days), 0)                        AS total_effort_days
        FROM artifacts WHERE project_id = $1
      `, [id])
    ]);

    if (!projRes.rows.length) return res.status(404).json({ error: 'Project not found' });

    const project   = projRes.rows[0];
    const artifacts = artRes.rows;
    const stats     = statsRes.rows[0];

    const html = generateHTMLReport(project, artifacts, stats);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('Report generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── DOWNLOAD — Full IS Content Package (all artifacts) ────────────────────────
router.get('/:id/download', async (req, res) => {
  const { projectId } = { projectId: req.params.id };
  try {
    // Load project
    const projResult = await pool.query('SELECT * FROM projects WHERE id = $1', [projectId]);
    if (!projResult.rows.length) return res.status(404).json({ error: 'Project not found' });
    const project = projResult.rows[0];

    // Load all artifacts — prioritise converted/validated ones, include all
    const artResult = await pool.query(
      `SELECT * FROM artifacts WHERE project_id = $1 ORDER BY complexity_score DESC`,
      [projectId]
    );
    const artifacts = artResult.rows;
    if (!artifacts.length) return res.status(404).json({ error: 'No artifacts found for this project' });

    // Load last conversion run for each artifact
    const runRows = await pool.query(
      `SELECT DISTINCT ON (artifact_id) artifact_id, convert_output
       FROM conversion_runs WHERE artifact_id = ANY($1)
       ORDER BY artifact_id, run_number DESC`,
      [artifacts.map(a => a.id)]
    );
    const runMap = {};
    runRows.rows.forEach(r => { runMap[r.artifact_id] = r.convert_output; });

    // SAP IS content package ZIP — metainfo.prop at root + individual iFlow bundle ZIPs
    const outerZip = new AdmZip();
    const safeProj = project.name.replace(/[^a-zA-Z0-9_\-]/g, '_');
    // pkgId must be consistent with the Package-Name written into each artifact's MANIFEST.MF
    // buildPackageName(artifact) uses artifact.domain || 'INT'; project artifacts default to 'INT'
    const pkgId    = `${safeProj}_IS_Package`.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const pkgName  = pkgId;
    const timestamp = new Date().toISOString().split('T')[0];
    const creationDate = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // metainfo.prop at root — required by SAP IS for content package import
    outerZip.addFile('metainfo.prop', Buffer.from(
      `bundleid=${pkgId}\n` +
      `bundleName=${project.name}\n` +
      `shortText=${project.name} - Migrated by IS Migration Tool (Sierra Digital)\n` +
      `vendor=Sierra Digital\n` +
      `version=1.0.0\n` +
      `SupportedPlatform=CloudIntegration\n` +
      `mode=DESIGN_TIME\n` +
      `CreationDate=${creationDate}\n`
    ));

    // Package manifest (for reference — SAP IS ignores non-ZIP / non-prop files)
    const manifestLines = [
      `# SAP Integration Suite Content Package`,
      `# Project: ${project.name}`,
      `# Customer: ${project.customer || '—'}`,
      `# Platform: ${(project.platform || 'UNKNOWN').toUpperCase()}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Tool: IS Migration Tool (Sierra Digital)`,
      `# Total Artifacts: ${artifacts.length}`,
      ``,
      `artifacts:`
    ];

    // Build each iFlow package and add the inner bundle ZIP directly to the package root
    let successCount = 0;
    let errorCount   = 0;

    for (const art of artifacts) {
      try {
        const connector  = getConnector(art.platform || project.platform);
        const platformData = await connector.getArtifactData(art);
        const convOutput = runMap[art.id] || null;

        const pkg = generateIFlowPackage(art, platformData, convOutput, pkgName);

        // Add inner bundle ZIP at root (not the outer content-package wrapper)
        outerZip.addFile(`${pkg.iflowId}.zip`, pkg.bundleBuffer);

        manifestLines.push(`  - id: ${pkg.iflowId}`);
        manifestLines.push(`    name: ${pkg.iflowName}`);
        manifestLines.push(`    file: ${pkg.iflowId}.zip`);
        manifestLines.push(`    complexity: ${art.complexity_level || 'Medium'}`);
        manifestLines.push(`    status: ${art.status || 'discovered'}`);
        manifestLines.push(`    readiness: ${art.readiness || 'Manual'}`);
        manifestLines.push(`    effort_days: ${art.effort_days || 0}`);
        manifestLines.push(``);

        successCount++;
      } catch (artErr) {
        console.error(`Package gen error for ${art.name}:`, artErr.message);
        manifestLines.push(`  - id: ${art.name}`);
        manifestLines.push(`    error: ${artErr.message}`);
        manifestLines.push(``);
        errorCount++;
      }
    }

    // Summary
    manifestLines.push(`summary:`);
    manifestLines.push(`  total: ${artifacts.length}`);
    manifestLines.push(`  packaged: ${successCount}`);
    manifestLines.push(`  errors: ${errorCount}`);
    manifestLines.push(`  total_effort_days: ${artifacts.reduce((s, a) => s + (a.effort_days || 0), 0)}`);

    outerZip.addFile('PACKAGE_MANIFEST.yaml', Buffer.from(manifestLines.join('\n') + '\n'));

    // Add a README
    const readme = buildPackageReadme(project, artifacts, successCount);
    outerZip.addFile('README.txt', Buffer.from(readme));

    const filename = `${safeProj}_IS_ContentPackage_${timestamp}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Package-Name', pkgName);
    res.setHeader('X-Artifact-Count', String(successCount));
    res.send(outerZip.toBuffer());

  } catch (err) {
    console.error('Project download error:', err);
    res.status(500).json({ error: err.message });
  }
});

function buildPackageReadme(project, artifacts, count) {
  const simple  = artifacts.filter(a => a.complexity_level === 'Simple').length;
  const medium  = artifacts.filter(a => a.complexity_level === 'Medium').length;
  const complex = artifacts.filter(a => a.complexity_level === 'Complex').length;
  const effort  = artifacts.reduce((s, a) => s + (a.effort_days || 0), 0);

  return `SAP INTEGRATION SUITE — MIGRATION CONTENT PACKAGE
===================================================
Project   : ${project.name}
Customer  : ${project.customer || '—'}
Platform  : ${(project.platform || 'UNKNOWN').toUpperCase()}
Generated : ${new Date().toISOString()}
Tool      : IS Migration Tool — Sierra Digital

CONTENTS
--------
This package contains ${count} iFlow ZIP file(s) ready for import into
SAP Integration Suite (SAP BTP Cloud Integration).

Each iFlow ZIP includes:
  • META-INF/MANIFEST.MF         — bundle metadata
  • src/.../integrationflow/*.iflw — BPMN2 iFlow definition (SAP IS format)
  • src/.../parameters.prop       — externalized parameters (update before deploy)
  • src/.../mapping/*.mmap        — message mapping stubs (if applicable)
  • src/.../script/*.groovy       — Groovy script stubs (if applicable)

COMPLEXITY BREAKDOWN
--------------------
  Simple  (auto-convert)  : ${simple} artifacts
  Medium  (semi-auto)     : ${medium} artifacts
  Complex (manual review) : ${complex} artifacts
  Total estimated effort  : ${effort} person-days

HOW TO IMPORT
-------------
1. Log into SAP Integration Suite (SAP BTP Cockpit)
2. Navigate to: Design → Integration Packages
3. Click "Import" and select an individual iFlow ZIP from the /iflows/ folder
4. OR create a new Integration Package and import via the package editor
5. Open each imported iFlow in the Integration Flow Designer
6. Update all {{PLACEHOLDER}} values in Configure tab before deploying
7. Deploy to Development tenant, run test messages, then promote to Production

IMPORTANT NOTES
---------------
• All {{PLACEHOLDER}} values in parameters.prop MUST be replaced with real values
• Groovy scripts (.groovy) contain STUBS — implement business logic before go-live
• Message mappings (.mmap) require XSD schema registration in IS designer
• Complex iFlows (${complex}) require manual review and testing with real payloads
• B2B adapters (AS2/IDoc) require additional SAP IS B2B/EDI Add-on license

Sierra Digital — SAP Integration Suite Migration Practice
https://sierradigital.com
`;
}

module.exports = router;
