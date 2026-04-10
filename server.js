const express = require('express');
const cors    = require('cors');
const path    = require('path');
const session = require('express-session');
require('dotenv').config();

const { initDb, pool }          = require('./database/db');
const { runSeed }               = require('./database/seed');
const { errorHandler }          = require('./middleware/error-handler');

const DEMO_PASSWORD   = process.env.DEMO_PASSWORD   || 'S!erraIS@Migr8#2025';
const SESSION_SECRET  = process.env.SESSION_SECRET  || 'sd-is-migration-secret-9f3x!k2';

const app = express();
app.set('trust proxy', 1); // Azure App Service terminates SSL at the load balancer
app.use(cors());
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000   // 8-hour session
  }
}));

// ── Auth endpoints (public — no guard) ────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== DEMO_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  req.session.authenticated = true;
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: req.session.authenticated === true });
});

// ── Auth guard — all /api/* routes require a session ─────────────────────────
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorised' });
}

// ── Static files (login.html is public, everything else guarded via SPA fallback)
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
app.use('/api/v1/projects',  requireAuth, routes.projects);
app.use('/api/v1/sources',   requireAuth, routes.sources);
app.use('/api/v1/artifacts', requireAuth, routes.artifacts);
app.use('/api/v1/analysis',  requireAuth, routes.analysis);
app.use('/api/v1/seed',      requireAuth, routes.seed);

// Legacy aliases — keeps existing frontend working without changes
app.use('/api/projects',  requireAuth, routes.projects);
app.use('/api/sources',   requireAuth, routes.sources);
app.use('/api/artifacts', requireAuth, routes.artifacts);
app.use('/api/analysis',  requireAuth, routes.analysis);
app.use('/api/seed',      requireAuth, routes.seed);

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
