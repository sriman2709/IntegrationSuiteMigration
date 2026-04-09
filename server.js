const express = require('express');
const cors    = require('cors');
const path    = require('path');
require('dotenv').config();

const { initDb, pool }          = require('./database/db');
const { runSeed }               = require('./database/seed');
const { errorHandler }          = require('./middleware/error-handler');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Health & Readiness probes (Azure App Service / AKS liveness checks) ───────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/ready',  async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready', db: 'connected', timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'not-ready', db: 'disconnected', error: e.message });
  }
});

// ── API routes — /api/v1 (canonical) with /api backward-compat aliases ─────────
const routes = {
  projects:  require('./routes/projects'),
  sources:   require('./routes/sources'),
  artifacts: require('./routes/artifacts'),
  analysis:  require('./routes/analysis'),
  seed:      require('./routes/seed')
};

// v1 canonical
app.use('/api/v1/projects',  routes.projects);
app.use('/api/v1/sources',   routes.sources);
app.use('/api/v1/artifacts', routes.artifacts);
app.use('/api/v1/analysis',  routes.analysis);
app.use('/api/v1/seed',      routes.seed);

// Legacy aliases — keeps existing frontend working without changes
app.use('/api/projects',  routes.projects);
app.use('/api/sources',   routes.sources);
app.use('/api/artifacts', routes.artifacts);
app.use('/api/analysis',  routes.analysis);
app.use('/api/seed',      routes.seed);

// ── SPA fallback (must come after all API routes) ─────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Global error handler (RFC 7807) ──────────────────────────────────────────
app.use(errorHandler);

const PORT = process.env.PORT || 4001;

async function start() {
  await initDb();

  // Auto-seed on first boot
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
    console.log(JSON.stringify({ level: 'info', message: 'Server started', port: PORT, timestamp: new Date().toISOString() }));
  });
}

start().catch(err => {
  console.error(JSON.stringify({ level: 'fatal', message: err.message, stack: err.stack }));
  process.exit(1);
});
