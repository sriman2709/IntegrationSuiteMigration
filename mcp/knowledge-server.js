#!/usr/bin/env node
'use strict';
/**
 * IS Migration Knowledge Base — MCP Server
 *
 * Exposes three tools to Claude:
 *   search_knowledge(query, category?)  — full-text search the knowledge base
 *   save_knowledge(category, title, content, platform?, tags?)  — persist a new pattern/decision
 *   list_categories()  — enumerate all knowledge categories
 *
 * Backed by the same PostgreSQL instance as the main app (DATABASE_URL env var).
 *
 * Registration in ~/.claude/claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "is-migration-knowledge": {
 *         "command": "node",
 *         "args": ["/Users/parisuchitha/projects/IntegrationSuiteMigration/mcp/knowledge-server.js"],
 *         "env": { "DATABASE_URL": "<your-azure-postgres-connection-string>" }
 *       }
 *     }
 *   }
 */

const { Server }     = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { Pool }       = require('pg');

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_knowledge',
    description: 'Search the IS Migration knowledge base for connector mappings, conversion patterns, sprint decisions, and platform-specific notes. Use this at the start of any conversion work to retrieve relevant prior knowledge.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-text search query (e.g. "MuleSoft scatter-gather iFlow", "TIBCO XSLT extraction", "MongoDB unmapped connector")'
        },
        category: {
          type: 'string',
          description: 'Optional: filter by category (connector_mapping, conversion_pattern, sprint_decision, platform_note, edge_case, client_specific)'
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 10)'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'save_knowledge',
    description: 'Save a new pattern, decision, or finding to the IS Migration knowledge base. Call this whenever you discover a new connector mapping, edge case, or conversion decision that should be remembered for future sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Category: connector_mapping | conversion_pattern | sprint_decision | platform_note | edge_case | client_specific | transformation_rule'
        },
        title: {
          type: 'string',
          description: 'Short title (e.g. "MuleSoft scatter-gather → SAP IS Multicast")'
        },
        content: {
          type: 'string',
          description: 'Full explanation, including source element, target element, any code snippets, caveats, and when to apply'
        },
        platform: {
          type: 'string',
          description: 'Optional: source platform (mulesoft | tibco | boomi | pipo | all)'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: tags for retrieval (e.g. ["routing", "parallel", "sprint4"])'
        }
      },
      required: ['category', 'title', 'content']
    }
  },
  {
    name: 'list_categories',
    description: 'List all knowledge categories with entry counts. Use to understand what knowledge is available before searching.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_sprint_context',
    description: 'Retrieve all knowledge entries for a specific sprint to restore full context at the start of a session.',
    inputSchema: {
      type: 'object',
      properties: {
        sprint: {
          type: 'string',
          description: 'Sprint identifier, e.g. "S1", "S4", "S7"'
        }
      },
      required: ['sprint']
    }
  }
];

// ── Server setup ──────────────────────────────────────────────────────────────
const server = new Server(
  { name: 'is-migration-knowledge', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'search_knowledge': return await searchKnowledge(args);
      case 'save_knowledge':   return await saveKnowledge(args);
      case 'list_categories':  return await listCategories();
      case 'get_sprint_context': return await getSprintContext(args);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true
    };
  }
});

// ── Tool implementations ──────────────────────────────────────────────────────

async function searchKnowledge({ query, category, limit = 10 }) {
  let sql = `
    SELECT id, category, title, content, platform, tags, source,
           ts_rank(search_vector, plainto_tsquery('english', $1)) AS rank
    FROM knowledge_base
    WHERE search_vector @@ plainto_tsquery('english', $1)
  `;
  const params = [query];

  if (category) {
    params.push(category);
    sql += ` AND category = $${params.length}`;
  }

  sql += ` ORDER BY rank DESC LIMIT $${params.length + 1}`;
  params.push(Math.min(limit, 50));

  const { rows } = await pool.query(sql, params);

  if (rows.length === 0) {
    // Fallback: ILIKE search for partial matches
    const fallbackSql = `
      SELECT id, category, title, content, platform, tags, source
      FROM knowledge_base
      WHERE title ILIKE $1 OR content ILIKE $1 OR category ILIKE $1
      ${category ? 'AND category = $2' : ''}
      LIMIT $${category ? 3 : 2}
    `;
    const fbParams = [`%${query}%`];
    if (category) fbParams.push(category);
    fbParams.push(Math.min(limit, 50));
    const fallback = await pool.query(fallbackSql, fbParams);
    if (fallback.rows.length === 0) {
      return { content: [{ type: 'text', text: `No knowledge found for: "${query}"` }] };
    }
    return formatResults(fallback.rows, query);
  }

  return formatResults(rows, query);
}

function formatResults(rows, query) {
  const text = rows.map((r, i) => [
    `[${i + 1}] ${r.category.toUpperCase()} — ${r.title}`,
    r.platform ? `Platform: ${r.platform}` : null,
    r.tags?.length ? `Tags: ${r.tags.join(', ')}` : null,
    ``,
    r.content,
    `---`
  ].filter(Boolean).join('\n')).join('\n\n');

  return { content: [{ type: 'text', text: `Found ${rows.length} result(s) for "${query}":\n\n${text}` }] };
}

async function saveKnowledge({ category, title, content, platform, tags = [] }) {
  // Check for duplicate title in same category
  const existing = await pool.query(
    'SELECT id FROM knowledge_base WHERE category = $1 AND title = $2',
    [category, title]
  );

  if (existing.rows.length > 0) {
    // Update existing entry
    await pool.query(
      'UPDATE knowledge_base SET content = $1, platform = $2, tags = $3, updated_at = NOW() WHERE id = $4',
      [content, platform || null, tags, existing.rows[0].id]
    );
    return { content: [{ type: 'text', text: `Updated existing knowledge entry: "${title}" in category "${category}"` }] };
  }

  // Insert new entry
  const { rows } = await pool.query(
    `INSERT INTO knowledge_base (category, title, content, platform, tags, source)
     VALUES ($1, $2, $3, $4, $5, 'claude')
     RETURNING id`,
    [category, title, content, platform || null, tags]
  );

  return { content: [{ type: 'text', text: `Saved new knowledge entry #${rows[0].id}: "${title}" in category "${category}"` }] };
}

async function listCategories() {
  const { rows } = await pool.query(`
    SELECT category, COUNT(*) as count,
           array_agg(DISTINCT platform) FILTER (WHERE platform IS NOT NULL) as platforms
    FROM knowledge_base
    GROUP BY category
    ORDER BY count DESC
  `);

  if (rows.length === 0) {
    return { content: [{ type: 'text', text: 'Knowledge base is empty. Start saving patterns with save_knowledge.' }] };
  }

  const text = rows.map(r =>
    `${r.category} (${r.count} entries)${r.platforms?.length ? ' — platforms: ' + r.platforms.join(', ') : ''}`
  ).join('\n');

  return { content: [{ type: 'text', text: `Knowledge base categories:\n\n${text}` }] };
}

async function getSprintContext({ sprint }) {
  const { rows } = await pool.query(
    `SELECT category, title, content, platform, tags
     FROM knowledge_base
     WHERE $1 = ANY(tags) OR title ILIKE $2 OR content ILIKE $2
     ORDER BY category, created_at`,
    [sprint.toLowerCase(), `%${sprint}%`]
  );

  if (rows.length === 0) {
    return { content: [{ type: 'text', text: `No knowledge entries found for sprint "${sprint}". Nothing saved yet for this sprint.` }] };
  }

  const text = rows.map(r => [
    `[${r.category}] ${r.title}`,
    r.platform ? `Platform: ${r.platform}` : null,
    r.content,
    '---'
  ].filter(Boolean).join('\n')).join('\n\n');

  return { content: [{ type: 'text', text: `Sprint ${sprint} context (${rows.length} entries):\n\n${text}` }] };
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function main() {
  // Ensure knowledge_base table exists (idempotent)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_base (
      id SERIAL PRIMARY KEY,
      category VARCHAR(100) NOT NULL,
      title VARCHAR(255) NOT NULL,
      content TEXT NOT NULL,
      platform VARCHAR(50),
      tags TEXT[] DEFAULT '{}',
      source VARCHAR(100) DEFAULT 'manual',
      search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'') || ' ' || coalesce(category,''))
      ) STORED,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS knowledge_base_search_idx ON knowledge_base USING GIN(search_vector)`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('IS Migration Knowledge MCP server running');
}

main().catch(err => {
  console.error('MCP server error:', err);
  process.exit(1);
});
