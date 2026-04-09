const express = require('express');
const router = express.Router();

// POST /api/seed — normal seed (idempotent, adds all 6 demo projects if missing)
router.post('/', async (req, res) => {
  try {
    const { runSeed } = require('../database/seed');
    await runSeed(false);
    res.json({ success: true, message: 'Demo data loaded: 6 projects (2 SLB + 4 generic), 142 artifacts', force: false });
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/seed/reset — force wipe + full reseed (demo reset)
router.post('/reset', async (req, res) => {
  try {
    const { runSeed } = require('../database/seed');
    await runSeed(true);
    res.json({ success: true, message: 'Database wiped and reseeded: 6 projects (2 SLB + 4 generic), 142 artifacts', force: true });
  } catch (err) {
    console.error('Force seed error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
