'use strict';
/**
 * Boomi Service — business logic layer for Boomi API sync and artifact assessment.
 * Routes call this; no API logic lives in route handlers.
 */

const BoomiConnector = require('../connectors/boomi');
const { pool }       = require('../database/db');

// ── Test connection with supplied credentials ─────────────────────────────────
async function testConnection(config) {
  const connector = new BoomiConnector();
  return connector.testConnection(config);
}

// ── Sync all processes from Boomi into a source_connection record ─────────────
async function syncSource(sourceId) {
  const srcRes = await pool.query('SELECT * FROM source_connections WHERE id = $1', [sourceId]);
  if (!srcRes.rows.length) throw Object.assign(new Error('Source not found'), { status: 404 });

  const source    = srcRes.rows[0];
  const connector = new BoomiConnector();
  const result    = await connector.syncAllProcesses();

  // Clear existing artifacts for this source
  await pool.query('DELETE FROM artifacts WHERE source_id = $1', [sourceId]);

  const inserted = [];
  for (const art of result.artifacts) {
    const r = await pool.query(
      `INSERT INTO artifacts
        (source_id, project_id, process_id, name, domain, platform, artifact_type, trigger_type,
         shapes_count, connectors_count, maps_count, has_scripting, scripting_detail, error_handling,
         dependencies_count, primary_connector, complexity_score, complexity_level, tshirt_size,
         effort_days, readiness, raw_metadata, raw_xml, data_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING *`,
      [source.id, source.project_id, art.process_id, art.name, art.domain, art.platform,
       art.artifact_type, art.trigger_type, art.shapes_count, art.connectors_count, art.maps_count,
       art.has_scripting, art.scripting_detail, art.error_handling, art.dependencies_count,
       art.primary_connector, art.complexity_score, art.complexity_level, art.tshirt_size,
       art.effort_days, art.readiness, JSON.stringify(art.raw_metadata || {}), art.raw_xml || null,
       art.raw_xml ? 'real' : 'mock']
    );
    inserted.push(r.rows[0]);
  }

  await pool.query(
    `UPDATE source_connections
     SET status = 'synced', artifacts_found = $1, last_synced_at = NOW(),
         config = config || $2
     WHERE id = $3`,
    [inserted.length, JSON.stringify({ dataSource: result.dataSource, lastProcessCount: result.processCount }), sourceId]
  );
  await pool.query('UPDATE projects SET updated_at = NOW() WHERE id = $1', [source.project_id]);

  return {
    success:        true,
    artifacts_found: inserted.length,
    data_source:    result.dataSource,   // 'live_api' | 'mock' | 'mock_fallback'
    process_count:  result.processCount,
    errors:         result.errors || []
  };
}

// ── Get enriched platform data for a single artifact (used in assess/convert) ─
async function getArtifactPlatformData(artifact) {
  const connector = new BoomiConnector();
  return connector.getArtifactData(artifact);
}

// ── Save / update Boomi credentials on a source connection ────────────────────
async function saveCredentials(sourceId, credentials) {
  const { accountId, username, token } = credentials;
  if (!accountId || !username || !token) {
    throw Object.assign(new Error('accountId, username, and token are required'), { status: 400 });
  }

  const res = await pool.query(
    `UPDATE source_connections
     SET config = config || $1, updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [JSON.stringify({ accountId, username, token }), sourceId]
  );
  if (!res.rows.length) throw Object.assign(new Error('Source not found'), { status: 404 });
  return { success: true, source: res.rows[0] };
}

module.exports = { testConnection, syncSource, getArtifactPlatformData, saveCredentials };
