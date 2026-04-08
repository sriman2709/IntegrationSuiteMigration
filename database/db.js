require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        customer VARCHAR(255) NOT NULL,
        consultant VARCHAR(255),
        platform VARCHAR(50) NOT NULL,
        description TEXT,
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS source_connections (
        id SERIAL PRIMARY KEY,
        project_id INT REFERENCES projects(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        name VARCHAR(255) NOT NULL,
        platform VARCHAR(50) NOT NULL,
        config JSONB DEFAULT '{}',
        status VARCHAR(50) DEFAULT 'pending',
        artifacts_found INT DEFAULT 0,
        last_synced_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id SERIAL PRIMARY KEY,
        source_id INT REFERENCES source_connections(id) ON DELETE CASCADE,
        project_id INT REFERENCES projects(id) ON DELETE CASCADE,
        process_id VARCHAR(255),
        name VARCHAR(255) NOT NULL,
        domain VARCHAR(100),
        platform VARCHAR(50) NOT NULL,
        artifact_type VARCHAR(100),
        trigger_type VARCHAR(100),
        shapes_count INT DEFAULT 0,
        connectors_count INT DEFAULT 0,
        maps_count INT DEFAULT 0,
        has_scripting BOOLEAN DEFAULT false,
        scripting_detail VARCHAR(255),
        error_handling VARCHAR(100),
        dependencies_count INT DEFAULT 0,
        primary_connector VARCHAR(100),
        complexity_score INT DEFAULT 0,
        complexity_level VARCHAR(50),
        tshirt_size VARCHAR(10),
        effort_days INT DEFAULT 0,
        readiness VARCHAR(50) DEFAULT 'Partial',
        status VARCHAR(50) DEFAULT 'discovered',
        raw_metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS artifact_assessments (
        id SERIAL PRIMARY KEY,
        artifact_id INT REFERENCES artifacts(id) ON DELETE CASCADE UNIQUE,
        findings JSONB DEFAULT '[]',
        recommendations JSONB DEFAULT '[]',
        iflow_name VARCHAR(255),
        iflow_package VARCHAR(255),
        migration_approach TEXT,
        identified_challenges JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS conversion_runs (
        id SERIAL PRIMARY KEY,
        artifact_id INT REFERENCES artifacts(id) ON DELETE CASCADE,
        run_number INT DEFAULT 1,
        convert_output TEXT,
        qa_results JSONB DEFAULT '{}',
        deploy_results JSONB DEFAULT '{}',
        validate_results JSONB DEFAULT '{}',
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS project_analysis (
        id SERIAL PRIMARY KEY,
        project_id INT REFERENCES projects(id) ON DELETE CASCADE UNIQUE,
        total_processes INT DEFAULT 0,
        simple_count INT DEFAULT 0,
        medium_count INT DEFAULT 0,
        complex_count INT DEFAULT 0,
        total_effort_days INT DEFAULT 0,
        migration_duration_months INT DEFAULT 0,
        complexity_distribution JSONB DEFAULT '{}',
        connector_summary JSONB DEFAULT '[]',
        domain_summary JSONB DEFAULT '[]',
        risks JSONB DEFAULT '[]',
        recommendations JSONB DEFAULT '[]',
        roadmap JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('Database schema initialized.');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };
