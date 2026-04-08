const express = require('express');
const router = express.Router();

router.post('/', async (req, res) => {
  try {
    // Require and run seed
    const { runSeed } = require('../database/seed');
    await runSeed();
    res.json({ success: true, message: 'Seed data loaded successfully' });
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
