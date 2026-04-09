'use strict';
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { pool }           = require('../database/db');
const boomiService       = require('../services/boomi-service');
const mulesoftService    = require('../services/mulesoft-service');
const { createError }    = require('../middleware/error-handler');

// ── File upload setup ─────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ── GET /api/sources/project/:projectId ──────────────────────────────────────
router.get('/project/:projectId', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM source_connections WHERE project_id = $1 ORDER BY created_at DESC',
      [req.params.projectId]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ── POST /api/sources — create source connection record ───────────────────────
router.post('/', async (req, res, next) => {
  const { project_id, type, name, platform, config } = req.body;
  if (!project_id || !type || !name || !platform)
    return next(createError(400, 'project_id, type, name, and platform are required'));
  try {
    const result = await pool.query(
      `INSERT INTO source_connections (project_id, type, name, platform, config)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [project_id, type, name, platform, JSON.stringify(config || {})]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/sources/test-connection — validate credentials before saving ────
router.post('/test-connection', async (req, res, next) => {
  const { platform, config } = req.body;
  if (!platform || !config) return next(createError(400, 'platform and config are required'));
  try {
    let result;
    if (platform === 'boomi') {
      result = await boomiService.testConnection(config);
    } else {
      // MuleSoft, PIPO, TIBCO — file-based, no live test needed
      result = { success: true, mode: 'file', message: `${platform} uses file upload — no live connection test required` };
    }
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/sources/upload — upload ZIP/XML and parse artifacts ─────────────
router.post('/upload', upload.single('artifact_file'), async (req, res, next) => {
  if (!req.file) return next(createError(400, 'No file uploaded'));
  const { project_id, platform, source_name } = req.body;
  if (!project_id || !platform) return next(createError(400, 'project_id and platform are required'));

  const filePath = req.file.path;
  try {
    if (platform === 'mulesoft') {
      // Use deep service parser (handles multi-file ZIPs natively)
      const result = await mulesoftService.parseAndPersist(filePath, req.file.originalname, project_id, source_name);
      return res.json(result);
    }

    // For other platforms — use existing parsers
    const parser = getParser(platform);
    let parsePath = filePath;

    if (req.file.originalname.endsWith('.zip')) {
      const AdmZip = require('adm-zip');
      const zip    = new AdmZip(filePath);
      const extractDir = `${filePath}_extracted`;
      zip.extractAllTo(extractDir, true);
      const xmlFiles = findXmlFiles(extractDir);
      if (xmlFiles.length) parsePath = xmlFiles[0];
    }

    const artifacts = await parser.parseArtifacts(parsePath, platform);
    const srcName   = source_name || req.file.originalname;

    const srcResult = await pool.query(
      `INSERT INTO source_connections (project_id, type, name, platform, config, status, artifacts_found, last_synced_at)
       VALUES ($1, 'zip', $2, $3, $4, 'synced', $5, NOW()) RETURNING *`,
      [project_id, srcName, platform, JSON.stringify({ filename: req.file.originalname, size: req.file.size }), artifacts.length]
    );
    const source   = srcResult.rows[0];
    const inserted = [];

    for (const art of artifacts) {
      const r = await pool.query(
        `INSERT INTO artifacts
          (source_id, project_id, process_id, name, domain, platform, artifact_type, trigger_type,
           shapes_count, connectors_count, maps_count, has_scripting, scripting_detail, error_handling,
           dependencies_count, primary_connector, complexity_score, complexity_level, tshirt_size, effort_days, readiness, raw_metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
        [source.id, project_id, art.process_id, art.name, art.domain, art.platform, art.artifact_type,
         art.trigger_type, art.shapes_count, art.connectors_count, art.maps_count, art.has_scripting,
         art.scripting_detail, art.error_handling, art.dependencies_count, art.primary_connector,
         art.complexity_score, art.complexity_level, art.tshirt_size, art.effort_days, art.readiness,
         JSON.stringify(art.raw_metadata || {})]
      );
      inserted.push(r.rows[0]);
    }

    await pool.query('UPDATE projects SET updated_at = NOW() WHERE id = $1', [project_id]);
    res.json({ source, artifacts: inserted, count: inserted.length });
  } catch (err) { next(err); }
});

// ── POST /api/sources/:id/sync — sync source (API or re-process) ──────────────
router.post('/:id/sync', async (req, res, next) => {
  const { id } = req.params;
  try {
    const srcRes = await pool.query('SELECT * FROM source_connections WHERE id = $1', [id]);
    if (!srcRes.rows.length) return next(createError(404, 'Source not found'));
    const source = srcRes.rows[0];

    if (source.platform === 'boomi' && source.type === 'api') {
      // Use Boomi service — handles live API or mock fallback automatically
      const result = await boomiService.syncSource(id);
      return res.json({
        success:        true,
        artifacts_found: result.artifacts_found,
        data_source:    result.data_source,   // 'live_api' | 'mock' | 'mock_fallback'
        process_count:  result.process_count,
        mode:           result.data_source === 'live_api' ? 'real' : 'mock',
        errors:         result.errors
      });
    }

    // ZIP-based sources are synced at upload time
    res.json({ success: true, message: 'File-based source synced at upload time', data_source: 'file_upload' });
  } catch (err) { next(err); }
});

// ── PATCH /api/sources/:id/credentials — save Boomi credentials ───────────────
router.patch('/:id/credentials', async (req, res, next) => {
  const { id } = req.params;
  try {
    const result = await boomiService.saveCredentials(id, req.body);
    res.json(result);
  } catch (err) { next(err); }
});

// ── DELETE /api/sources/:id ───────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM source_connections WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function getParser(platform) {
  const parsers = { boomi: require('../parsers/boomi'), pipo: require('../parsers/pipo'), tibco: require('../parsers/tibco'), mulesoft: require('../parsers/mulesoft') };
  return parsers[platform] || parsers.boomi;
}

function findXmlFiles(dir) {
  const results = [];
  try {
    for (const item of fs.readdirSync(dir)) {
      const full = path.join(dir, item);
      if (fs.statSync(full).isDirectory()) results.push(...findXmlFiles(full));
      else if (item.endsWith('.xml')) results.push(full);
    }
  } catch (e) { /* ignore */ }
  return results;
}

module.exports = router;
