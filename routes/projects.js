const express = require('express');
const router = express.Router();
const { pool } = require('../database/db');

// List all projects with artifact counts
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*,
        COUNT(DISTINCT a.id) AS artifact_count,
        COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'converted') AS converted_count,
        COUNT(DISTINCT a.id) FILTER (WHERE a.readiness = 'Auto') AS auto_count
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

module.exports = router;
