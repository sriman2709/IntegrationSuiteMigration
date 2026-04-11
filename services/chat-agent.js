'use strict';
/**
 * Migration Intelligence Chat Agent (Sprint 11)
 *
 * Grounds OpenAI GPT-4o responses in:
 *   1. Project + artifact data from Azure Postgres (what's actually in the user's universe)
 *   2. Knowledge base (connector mappings, conversion rules, IS patterns — seeded in S0)
 *
 * Returns a stream of Server-Sent Events (text/event-stream).
 */

const { pool } = require('../database/db');
const { OpenAI } = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Main entry — called by routes/chat.js, writes SSE to res ────────────────
async function streamChatResponse(question, projectId, res) {
  // 1. Retrieve context from DB
  const context = await buildContext(question, projectId);

  // 2. Build system prompt grounded in that context
  const systemPrompt = buildSystemPrompt(context);

  // 3. Stream from OpenAI GPT-4o
  try {
    const stream = await openai.chat.completions.create({
      model: 'gpt-4o',
      stream: true,
      max_tokens: 1024,
      temperature: 0.3,
      messages: [
        { role: 'system',    content: systemPrompt },
        { role: 'user',      content: question }
      ]
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        res.write(`data: ${JSON.stringify({ token: delta })}\n\n`);
      }
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }

  res.end();
}

// ── Build retrieval context from Postgres ────────────────────────────────────
async function buildContext(question, projectId) {
  const ctx = {
    projects:         [],
    artifactSummary:  {},
    topArtifacts:     [],
    knowledgeEntries: [],
    conversionNotes:  []
  };

  try {
    // All projects
    const pRes = await pool.query(`
      SELECT id, name, platform, status,
             (SELECT COUNT(*) FROM artifacts WHERE project_id = p.id) as artifact_count
      FROM projects p ORDER BY updated_at DESC LIMIT 10
    `);
    ctx.projects = pRes.rows;

    // Artifact summary — counts by platform, readiness, complexity
    const summaryQ = projectId
      ? `SELECT platform, readiness, complexity_level, conversion_status,
                COUNT(*) as count,
                AVG(complexity_score)::int as avg_score,
                SUM(maps_count) as total_maps,
                COUNT(CASE WHEN has_scripting THEN 1 END) as scripting_count
         FROM artifacts WHERE project_id = $1
         GROUP BY platform, readiness, complexity_level, conversion_status`
      : `SELECT platform, readiness, complexity_level, conversion_status,
                COUNT(*) as count,
                AVG(complexity_score)::int as avg_score,
                SUM(maps_count) as total_maps,
                COUNT(CASE WHEN has_scripting THEN 1 END) as scripting_count
         FROM artifacts GROUP BY platform, readiness, complexity_level, conversion_status`;
    const sumRes = await pool.query(summaryQ, projectId ? [projectId] : []);
    ctx.artifactSummary = groupSummary(sumRes.rows);

    // Top artifacts most relevant to the question (keyword match on name/platform/connector)
    const keywords = extractKeywords(question);
    const kw       = keywords.length > 0 ? `%${keywords[0]}%` : '%';
    const artQ     = projectId
      ? `SELECT name, platform, artifact_type, trigger_type, complexity_level,
                readiness, primary_connector, connector_types, maps_count,
                has_scripting, error_handling, conversion_status, conversion_completeness,
                conversion_notes
         FROM artifacts
         WHERE project_id = $1
           AND (LOWER(name) LIKE $2 OR LOWER(platform) LIKE $2
                OR LOWER(primary_connector) LIKE $2 OR LOWER(readiness) LIKE $2)
         ORDER BY complexity_score DESC LIMIT 8`
      : `SELECT name, platform, artifact_type, trigger_type, complexity_level,
                readiness, primary_connector, connector_types, maps_count,
                has_scripting, error_handling, conversion_status, conversion_completeness,
                conversion_notes
         FROM artifacts
         WHERE LOWER(name) LIKE $1 OR LOWER(platform) LIKE $1
               OR LOWER(primary_connector) LIKE $1 OR LOWER(readiness) LIKE $1
         ORDER BY complexity_score DESC LIMIT 8`;
    const artRes = await pool.query(artQ, projectId ? [projectId, kw] : [kw]);
    ctx.topArtifacts = artRes.rows;

    // If not enough results, pull top complex artifacts anyway
    if (ctx.topArtifacts.length < 3) {
      const fallbackQ = projectId
        ? `SELECT name, platform, artifact_type, trigger_type, complexity_level,
                  readiness, primary_connector, maps_count, has_scripting,
                  conversion_status, conversion_completeness
           FROM artifacts WHERE project_id = $1 ORDER BY complexity_score DESC LIMIT 5`
        : `SELECT name, platform, artifact_type, trigger_type, complexity_level,
                  readiness, primary_connector, maps_count, has_scripting,
                  conversion_status, conversion_completeness
           FROM artifacts ORDER BY complexity_score DESC LIMIT 5`;
      const fb = await pool.query(fallbackQ, projectId ? [projectId] : []);
      const existing = new Set(ctx.topArtifacts.map(a => a.name));
      ctx.topArtifacts.push(...fb.rows.filter(r => !existing.has(r.name)));
    }

    // Knowledge base — search for relevant entries
    const kbKeywords = keywords.slice(0, 3);
    if (kbKeywords.length > 0) {
      const kbRes = await pool.query(`
        SELECT category, title, content, tags
        FROM knowledge_base
        WHERE LOWER(content) LIKE ANY($1::text[])
           OR LOWER(title)   LIKE ANY($1::text[])
           OR LOWER(tags::text) LIKE ANY($1::text[])
        ORDER BY category LIMIT 6
      `, [kbKeywords.map(k => `%${k}%`)]);
      ctx.knowledgeEntries = kbRes.rows;
    }

    // Recent conversion notes (flags) from converted artifacts
    const notesQ = projectId
      ? `SELECT name, platform, conversion_notes, conversion_completeness, readiness
         FROM artifacts
         WHERE project_id = $1
           AND conversion_notes IS NOT NULL
           AND conversion_notes != '[]'::jsonb
         ORDER BY converted_at DESC LIMIT 5`
      : `SELECT name, platform, conversion_notes, conversion_completeness, readiness
         FROM artifacts
         WHERE conversion_notes IS NOT NULL AND conversion_notes != '[]'::jsonb
         ORDER BY converted_at DESC LIMIT 5`;
    const notesRes = await pool.query(notesQ, projectId ? [projectId] : []);
    ctx.conversionNotes = notesRes.rows;

  } catch (err) {
    console.error('[ChatAgent] Context retrieval error:', err.message);
  }

  return ctx;
}

// ── Build grounded system prompt ─────────────────────────────────────────────
function buildSystemPrompt(ctx) {
  const totalArtifacts = Object.values(ctx.artifactSummary.byPlatform || {})
    .reduce((s, n) => s + n, 0);

  const readinessSummary = ctx.artifactSummary.byReadiness
    ? Object.entries(ctx.artifactSummary.byReadiness)
        .map(([r, n]) => `${n} ${r}`)
        .join(', ')
    : 'unknown';

  const platformSummary = ctx.artifactSummary.byPlatform
    ? Object.entries(ctx.artifactSummary.byPlatform)
        .map(([p, n]) => `${n} ${p}`)
        .join(', ')
    : 'unknown';

  const artifactDetails = ctx.topArtifacts.length > 0
    ? ctx.topArtifacts.map(a =>
        `- ${a.name} [${a.platform}/${a.artifact_type}] | trigger: ${a.trigger_type} | ` +
        `complexity: ${a.complexity_level} | readiness: ${a.readiness} | ` +
        `connector: ${a.primary_connector || 'unknown'} | maps: ${a.maps_count || 0} | ` +
        `scripting: ${a.has_scripting ? 'yes' : 'no'} | ` +
        `conversion: ${a.conversion_status || 'pending'} ${a.conversion_completeness ? `(${a.conversion_completeness}%)` : ''}`
      ).join('\n')
    : 'No artifact details available.';

  const notesDetails = ctx.conversionNotes.length > 0
    ? ctx.conversionNotes.map(a => {
        const notes = Array.isArray(a.conversion_notes) ? a.conversion_notes : [];
        const flagStr = notes.map(f => `${f.type}(${f.severity})`).join(', ');
        return `- ${a.name} [${a.platform}]: ${a.conversion_completeness || '?'}% complete, readiness: ${a.readiness}, flags: ${flagStr || 'none'}`;
      }).join('\n')
    : 'No conversion results yet.';

  const kbDetails = ctx.knowledgeEntries.length > 0
    ? ctx.knowledgeEntries.map(k =>
        `[${k.category}] ${k.title}: ${k.content.substring(0, 200)}`
      ).join('\n')
    : '';

  const projectList = ctx.projects.length > 0
    ? ctx.projects.map(p => `- ${p.name} (${p.platform || 'multi'}, ${p.artifact_count} artifacts, status: ${p.status || 'active'})`).join('\n')
    : 'No projects found.';

  return `You are the Migration Intelligence Agent for Sierra Digital's SAP Integration Suite Migration Accelerator.

You help consultants and their clients understand, plan, and execute migrations from MuleSoft, TIBCO BW5, TIBCO BW6, and Boomi to SAP Integration Suite (IS).

You have direct access to the client's live migration data. Answer questions based on this real data. Be specific, use actual numbers and artifact names. Be concise and action-oriented — this is a consulting tool, not a chatbot.

═══════════════════════════════════════
LIVE MIGRATION UNIVERSE (from Postgres DB)
═══════════════════════════════════════

PROJECTS:
${projectList}

ARTIFACT TOTALS: ${totalArtifacts} artifacts
By platform: ${platformSummary}
By readiness: ${readinessSummary}

TOP/RELEVANT ARTIFACTS:
${artifactDetails}

CONVERSION QUALITY (recent results):
${notesDetails}

${kbDetails ? `KNOWLEDGE BASE (relevant entries):\n${kbDetails}` : ''}

═══════════════════════════════════════
BEHAVIOUR RULES
═══════════════════════════════════════
- Always ground answers in the data above. Never invent artifact names or numbers.
- For migration advice, use SAP IS best practices (IS Cloud Edition, BPMN2, externalized parameters, Secure Store, Process Direct).
- For unmapped connectors (MongoDB, Kafka, S3, AMQP), always recommend the HTTPS REST API alternative.
- Flag SCRIPTING_PRESERVED items as requiring developer review — never say they're done.
- Readiness: Auto = deploy-ready, Partial = needs developer review, Manual = significant rework.
- Keep answers under 300 words unless a detailed plan is explicitly requested.
- Use bullet points and clear structure. No filler sentences.`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractKeywords(question) {
  const stopWords = new Set(['what', 'which', 'how', 'many', 'are', 'the', 'my', 'is', 'in', 'a', 'an', 'do', 'i', 'can', 'for', 'to', 'of', 'and', 'or', 'have', 'has', 'with', 'that', 'this', 'all', 'any', 'tell', 'me', 'about', 'give', 'show', 'list']);
  return question.toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .slice(0, 5);
}

function groupSummary(rows) {
  const byPlatform  = {};
  const byReadiness = {};
  const byStatus    = {};
  for (const r of rows) {
    const n = parseInt(r.count);
    byPlatform[r.platform]   = (byPlatform[r.platform]   || 0) + n;
    byReadiness[r.readiness] = (byReadiness[r.readiness] || 0) + n;
    byStatus[r.conversion_status || 'pending'] = (byStatus[r.conversion_status || 'pending'] || 0) + n;
  }
  return { byPlatform, byReadiness, byStatus };
}

module.exports = { streamChatResponse };
