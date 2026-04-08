const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { initDb, pool } = require('./database/db');
const { runSeed } = require('./database/seed');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/projects', require('./routes/projects'));
app.use('/api/sources', require('./routes/sources'));
app.use('/api/artifacts', require('./routes/artifacts'));
app.use('/api/analysis', require('./routes/analysis'));
app.use('/api/seed', require('./routes/seed'));

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 4001;

async function start() {
  await initDb();

  // Auto-seed demo data on first boot (if no projects exist)
  try {
    const { rows } = await pool.query('SELECT COUNT(*) FROM projects');
    if (parseInt(rows[0].count) === 0) {
      console.log('No data found — seeding demo data...');
      await runSeed();
      console.log('Demo data seeded ✓');
    }
  } catch (e) {
    console.warn('Auto-seed skipped:', e.message);
  }

  app.listen(PORT, () => {
    console.log(`Integration Suite Migration Tool running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
