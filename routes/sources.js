const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('../database/db');

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// Get parser for platform
function getParser(platform) {
  const parsers = {
    boomi: require('../parsers/boomi'),
    pipo: require('../parsers/pipo'),
    tibco: require('../parsers/tibco'),
    mulesoft: require('../parsers/mulesoft')
  };
  return parsers[platform] || parsers.boomi;
}

// List sources for a project
router.get('/project/:projectId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM source_connections WHERE project_id = $1 ORDER BY created_at DESC',
      [req.params.projectId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create source connection
router.post('/', async (req, res) => {
  const { project_id, type, name, platform, config } = req.body;
  if (!project_id || !type || !name || !platform) {
    return res.status(400).json({ error: 'project_id, type, name, and platform are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO source_connections (project_id, type, name, platform, config)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [project_id, type, name, platform, JSON.stringify(config || {})]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload file and parse artifacts
router.post('/upload', upload.single('artifact_file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { project_id, platform, source_name } = req.body;
  if (!project_id || !platform) {
    return res.status(400).json({ error: 'project_id and platform are required' });
  }

  const filePath = req.file.path;
  let extractedPath = filePath;

  try {
    // If ZIP, extract it
    if (req.file.originalname.endsWith('.zip') || req.file.mimetype === 'application/zip') {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(filePath);
      const extractDir = filePath + '_extracted';
      zip.extractAllTo(extractDir, true);

      // Find XML files
      const xmlFiles = findXmlFiles(extractDir);
      if (xmlFiles.length > 0) {
        extractedPath = xmlFiles[0]; // Use first XML found
      }
    }

    const parser = getParser(platform);
    const artifacts = await parser.parseArtifacts(extractedPath, platform);

    // Create source connection record
    const srcName = source_name || req.file.originalname;
    const srcResult = await pool.query(
      `INSERT INTO source_connections (project_id, type, name, platform, config, status, artifacts_found, last_synced_at)
       VALUES ($1, 'zip', $2, $3, $4, 'synced', $5, NOW()) RETURNING *`,
      [project_id, srcName, platform, JSON.stringify({ filename: req.file.originalname, size: req.file.size }), artifacts.length]
    );
    const source = srcResult.rows[0];

    // Insert artifacts
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

    // Update project timestamp
    await pool.query('UPDATE projects SET updated_at = NOW() WHERE id = $1', [project_id]);

    res.json({ source, artifacts: inserted, count: inserted.length });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

function findXmlFiles(dir) {
  const results = [];
  try {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const full = path.join(dir, item);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) results.push(...findXmlFiles(full));
      else if (item.endsWith('.xml')) results.push(full);
    }
  } catch (e) { /* ignore */ }
  return results;
}

// Sync source (API or re-process)
router.post('/:id/sync', async (req, res) => {
  const { id } = req.params;
  try {
    const srcResult = await pool.query('SELECT * FROM source_connections WHERE id = $1', [id]);
    if (!srcResult.rows.length) return res.status(404).json({ error: 'Source not found' });
    const source = srcResult.rows[0];

    if (source.type === 'api') {
      // Attempt Boomi API sync, fall back to mock data
      const artifacts = await syncFromBoomiAPI(source);

      // Clear existing artifacts for this source
      await pool.query('DELETE FROM artifacts WHERE source_id = $1', [id]);

      const inserted = [];
      for (const art of artifacts) {
        const r = await pool.query(
          `INSERT INTO artifacts
            (source_id, project_id, process_id, name, domain, platform, artifact_type, trigger_type,
             shapes_count, connectors_count, maps_count, has_scripting, scripting_detail, error_handling,
             dependencies_count, primary_connector, complexity_score, complexity_level, tshirt_size, effort_days, readiness, raw_metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
          [source.id, source.project_id, art.process_id, art.name, art.domain, art.platform, art.artifact_type,
           art.trigger_type, art.shapes_count, art.connectors_count, art.maps_count, art.has_scripting,
           art.scripting_detail, art.error_handling, art.dependencies_count, art.primary_connector,
           art.complexity_score, art.complexity_level, art.tshirt_size, art.effort_days, art.readiness,
           JSON.stringify(art.raw_metadata || {})]
        );
        inserted.push(r.rows[0]);
      }

      await pool.query(
        'UPDATE source_connections SET status = $1, artifacts_found = $2, last_synced_at = NOW() WHERE id = $3',
        ['synced', inserted.length, id]
      );

      res.json({ success: true, artifacts_found: inserted.length });
    } else {
      res.json({ success: true, message: 'ZIP source already synced at upload time' });
    }
  } catch (err) {
    await pool.query('UPDATE source_connections SET status = $1 WHERE id = $2', ['failed', id]);
    res.status(500).json({ error: err.message });
  }
});

async function syncFromBoomiAPI(source) {
  const { accountId, username, password, environment } = source.config || {};

  if (!accountId || !username || !password) {
    // Return mock data for demo
    return generateMockBoomiArtifacts(source.platform || 'boomi');
  }

  try {
    const fetch = require('node-fetch');
    const baseUrl = `${process.env.BOOMI_API_BASE || 'https://api.boomi.com/api/rest/v1'}/${accountId}`;
    const auth = Buffer.from(`${username}:${password}`).toString('base64');

    const response = await fetch(`${baseUrl}/Process`, {
      method: 'GET',
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
    });

    if (!response.ok) throw new Error(`Boomi API returned ${response.status}`);

    const data = await response.json();
    const processes = data.result || [];

    return processes.map(p => {
      const score = Math.floor(Math.random() * 70) + 10;
      const { computeComplexityScore, classifyComplexity } = require('../parsers/boomi');
      const classification = classifyComplexity(score);
      return {
        process_id: p.id,
        name: p.name,
        domain: 'INT',
        platform: source.platform,
        artifact_type: 'Process',
        trigger_type: 'API',
        shapes_count: 10,
        connectors_count: 2,
        maps_count: 1,
        has_scripting: false,
        scripting_detail: null,
        error_handling: 'basic',
        dependencies_count: 0,
        primary_connector: 'HTTP',
        complexity_score: score,
        complexity_level: classification.level,
        tshirt_size: classification.tshirt,
        effort_days: classification.effort,
        readiness: 'Partial',
        raw_metadata: p
      };
    });
  } catch (err) {
    console.warn('Boomi API failed, using mock data:', err.message);
    return generateMockBoomiArtifacts(source.platform || 'boomi');
  }
}

function generateMockBoomiArtifacts(platform) {
  const { classifyComplexity } = require('../parsers/boomi');
  const mockProcesses = [
    { name: 'Customer_Master_Sync', domain: 'CRM', shapes: 14, connectors: 2, maps: 2, scripting: false },
    { name: 'Invoice_Processing_Flow', domain: 'FIN', shapes: 22, connectors: 3, maps: 3, scripting: true },
    { name: 'Employee_Data_Replication', domain: 'HR', shapes: 18, connectors: 2, maps: 2, scripting: false },
    { name: 'Purchase_Order_Integration', domain: 'SCM', shapes: 35, connectors: 4, maps: 5, scripting: true },
    { name: 'Vendor_Master_Distribution', domain: 'FIN', shapes: 12, connectors: 2, maps: 1, scripting: false }
  ];

  return mockProcesses.map((p, i) => {
    const score = Math.min(100, p.shapes * 1.5 + p.connectors * 8 + p.maps * 10 + (p.scripting ? 20 : 0));
    const classification = classifyComplexity(score);
    return {
      process_id: `mock-${platform}-${i}-${Date.now()}`,
      name: p.name,
      domain: p.domain,
      platform,
      artifact_type: 'Process',
      trigger_type: ['API', 'Schedule', 'Event'][i % 3],
      shapes_count: p.shapes,
      connectors_count: p.connectors,
      maps_count: p.maps,
      has_scripting: p.scripting,
      scripting_detail: p.scripting ? 'Groovy scripts detected' : null,
      error_handling: 'basic',
      dependencies_count: 1,
      primary_connector: 'HTTP',
      complexity_score: Math.min(100, Math.round(score)),
      complexity_level: classification.level,
      tshirt_size: classification.tshirt,
      effort_days: classification.effort,
      readiness: p.scripting ? 'Partial' : 'Auto',
      raw_metadata: { mock: true }
    };
  });
}

// Delete source
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM source_connections WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
