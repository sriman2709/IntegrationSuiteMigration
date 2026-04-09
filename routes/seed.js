const express = require('express');
const router = express.Router();

// POST /api/seed — normal seed (idempotent, only adds SLB projects if missing)
router.post('/', async (req, res) => {
  try {
    const { runSeed } = require('../database/seed');
    await runSeed(false);
    res.json({ success: true, message: 'SLB seed data loaded successfully', force: false });
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/seed/reset — force wipe + reseed (demo reset button)
router.post('/reset', async (req, res) => {
  try {
    const { runSeed } = require('../database/seed');
    await runSeed(true);
    res.json({ success: true, message: 'Database wiped and reseeded with SLB demo data', force: true });
  } catch (err) {
    console.error('Force seed error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
