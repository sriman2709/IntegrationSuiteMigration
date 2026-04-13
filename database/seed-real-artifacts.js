'use strict';
/**
 * seed-real-artifacts.js
 *
 * Seeds real MuleSoft and TIBCO BW6 artifacts from test-data/ into Azure Postgres.
 * Each artifact gets its actual raw_xml populated so the full pipeline
 * (assess → convert → quality → download) can be tested end-to-end.
 *
 * Run: node database/seed-real-artifacts.js
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { pool } = require('./db');

const BASE = path.join(__dirname, '..', 'test-data');

// ── Artifacts to seed ─────────────────────────────────────────────────────────
// Each entry maps to one file. artifact_type drives which parser is used.
const MULESOFT_FILES = [
  {
    name: 'Hello_World_HTTP',
    file: 'anypoint-examples-3.8/hello-world/src/main/app/HelloWorld.xml',
    artifact_type: 'Flow',
    description: 'Simple HTTP listener returning Hello World — baseline test'
  },
  {
    name: 'HTTP_Request_With_Logger',
    file: 'anypoint-examples-3.8/http-request-response-with-logger/src/main/app/echo.xml',
    artifact_type: 'Flow',
    description: 'HTTP echo service with logger step'
  },
  {
    name: 'Content_Based_Routing',
    file: 'anypoint-examples-3.8/content-based-routing/src/main/app/content-based-routing.xml',
    artifact_type: 'Flow',
    description: 'Choice router based on message content'
  },
  {
    name: 'Scatter_Gather_Flow',
    file: 'anypoint-examples-3.8/scatter-gather-flow-control/src/main/app/scatter-gather.xml',
    artifact_type: 'Flow',
    description: 'Scatter-gather pattern merging multiple sources'
  },
  {
    name: 'Foreach_And_Choice_Routing',
    file: 'anypoint-examples-3.8/foreach-processing-and-choice-routing/src/main/app/loanbroker-simple.xml',
    artifact_type: 'Flow',
    description: 'Loan broker — foreach iteration + choice routing'
  },
  {
    name: 'Choice_Exception_Strategy',
    file: 'anypoint-examples-3.8/implementing-a-choice-exception-strategy/src/main/app/choice-error-handling.xml',
    artifact_type: 'Flow',
    description: 'Error handling with choice exception strategy'
  },
  {
    name: 'DataWeave_Orders_API',
    file: 'anypoint-examples-3.8/processing-orders-with-dataweave-and-APIkit/src/main/app/books.xml',
    artifact_type: 'Flow',
    description: 'DataWeave 1.0 transformation with APIkit — SCRIPTING_PRESERVED flag expected'
  },
  {
    name: 'Database_To_JSON',
    file: 'anypoint-examples-3.8/querying-a-mysql-database/src/main/app/database-to-json.xml',
    artifact_type: 'Flow',
    description: 'MySQL DB query → JSON response — JDBC receiver adapter'
  },
  {
    name: 'JSON_To_JMS_Queue',
    file: 'anypoint-examples-3.8/sending-json-data-to-a-jms-queue/src/main/app/json-to-jms.xml',
    artifact_type: 'Flow',
    description: 'HTTP → JSON transform → JMS queue publish'
  },
  {
    name: 'CSV_To_MongoDB',
    file: 'anypoint-examples-3.8/importing-a-CSV-file-into-Mongo-DB/src/main/app/csv-to-mongodb.xml',
    artifact_type: 'Flow',
    description: 'CSV file import into MongoDB — UNMAPPED_CONNECTOR flag expected'
  },
  {
    name: 'SMTP_CSV_Email',
    file: 'anypoint-examples-3.8/sending-a-csv-file-through-email-using-smtp/src/main/app/csv-to-smtp.xml',
    artifact_type: 'Flow',
    description: 'CSV generation and email via SMTP'
  },
  {
    name: 'SOAP_Webservice_Consumer',
    file: 'anypoint-examples-3.8/web-service-consumer/src/main/app/tshirt-service-consumer.xml',
    artifact_type: 'Flow',
    description: 'SOAP web service consumer with DataWeave'
  },
  {
    name: 'Service_Orchestration_Choice',
    file: 'anypoint-examples-3.8/service-orchestration-and-choice-routing/src/main/app/fulfillment.xml',
    artifact_type: 'Flow',
    description: 'Multi-step service orchestration with choice routing'
  },
  {
    name: 'Salesforce_To_MySQL_Batch',
    file: 'anypoint-examples-3.8/salesforce-to-MySQL-DB-using-Batch-Processing/src/main/app/salesforce-to-database.xml',
    artifact_type: 'Batch',
    description: 'Salesforce bulk export → MySQL batch insert'
  },
  {
    name: 'JMS_Rollback_Redelivery',
    file: 'anypoint-examples-3.8/jms-message-rollback-and-redelivery/src/main/app/jms-redelivery.xml',
    artifact_type: 'Flow',
    description: 'JMS transactional flow with rollback and redelivery'
  }
];

const TIBCO_BW5_FILES = [
  {
    name: 'BW5_Common_SOAP_Handler',
    file: 'tibco-businessworks5-main/GenericSOAPGateway/GenericSOAPGateway/Processes/CommonHandler.process',
    artifact_type: 'ProcessDef',
    description: 'TIBCO BW5 generic SOAP gateway common handler — SOAP receive + invoke + mapper'
  },
  {
    name: 'BW5_Startup_SOAP_Gateway',
    file: 'tibco-businessworks5-main/GenericSOAPGateway/GenericSOAPGateway/Processes/Startup_GenericSOAPGateway.process',
    artifact_type: 'ProcessDef',
    description: 'TIBCO BW5 startup process — timer trigger + subprocess calls'
  },
  {
    name: 'BW5_Invalid_Data_Handler',
    file: 'tibco-businessworks5-main/GenericSOAPGateway/GenericSOAPGateway/Processes/InvalidDataHandler.process',
    artifact_type: 'ProcessDef',
    description: 'TIBCO BW5 invalid data error handler — catch + log + SOAP fault'
  },
  {
    name: 'BW5_Get_WSDL',
    file: 'tibco-businessworks5-main/GenericSOAPGateway/GenericSOAPGateway/Processes/GetWSDL.process',
    artifact_type: 'ProcessDef',
    description: 'TIBCO BW5 WSDL retrieval process — HTTP receive + file read + SOAP reply'
  },
  {
    name: 'BW5_Find_Customer_SOAP',
    file: 'tibco-businessworks5-main/GenericSOAPGateway/GenericSOAPGateway/Processes/Services/S0001.FindCustomer.2.InputMap.process',
    artifact_type: 'ProcessDef',
    description: 'TIBCO BW5 FindCustomer XSLT input mapper subprocess'
  }
];

const TIBCO_BW6_FILES = [
  {
    name: 'BW6_Logging_Service',
    file: 'bw-samples-master/TN2018/Apps/LoggingService/Processes/loggingservice/LogProcess.bwp',
    artifact_type: 'BW6Process',
    description: 'TIBCO BW6 logging service — file write + log activities'
  },
  {
    name: 'BW6_Credit_App_Main',
    file: 'bw-samples-master/TN2018/Apps/CreditAppService/CreditApp.module/Processes/creditapp/module/MainProcess.bwp',
    artifact_type: 'BW6Process',
    description: 'TIBCO BW6 credit application main process — scatter-gather pattern'
  },
  {
    name: 'BW6_Credit_Check_Backend',
    file: 'bw-samples-master/TN2018/Apps/CreditCheckBackendService/CreditCheckService/Processes/creditcheckservice/Process.bwp',
    artifact_type: 'BW6Process',
    description: 'TIBCO BW6 credit check backend — HTTP receive + JDBC lookup'
  },
  {
    name: 'BW6_Credit_DB_Lookup',
    file: 'bw-samples-master/TN2018/Apps/CreditCheckBackendService/CreditCheckService/Processes/creditcheckservice/LookupDatabase.bwp',
    artifact_type: 'BW6Process',
    description: 'TIBCO BW6 database lookup subprocess'
  },
  {
    name: 'BW6_Equifax_Score',
    file: 'bw-samples-master/TN2018/Apps/CreditAppService/CreditApp.module/Processes/creditapp/module/EquifaxScore.bwp',
    artifact_type: 'BW6Process',
    description: 'TIBCO BW6 Equifax credit score integration'
  }
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log('Connecting to Azure Postgres…');

  // Find or create a dedicated test project
  let projectId;
  const existing = await pool.query(
    `SELECT id FROM projects WHERE name = 'Real Artifact Tests' LIMIT 1`
  );
  if (existing.rows.length) {
    projectId = existing.rows[0].id;
    console.log(`Using existing project id=${projectId}`);
  } else {
    const ins = await pool.query(
      `INSERT INTO projects (name, customer, consultant, description, status, platform)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      ['Real Artifact Tests', 'Sierra Digital', 'Sriman Narayanan',
       'Live test project seeded from anypoint-examples-3.8 and bw-samples-master',
       'active', 'mulesoft']
    );
    projectId = ins.rows[0].id;
    console.log(`Created project id=${projectId}`);
  }

  // Find an existing source_id to associate (or leave null)
  const existingSrc = await pool.query(
    `SELECT id FROM artifacts WHERE project_id = $1 AND source_id IS NOT NULL LIMIT 1`,
    [projectId]
  );
  const sourceId = existingSrc.rows[0]?.source_id || null;

  // Seed MuleSoft
  console.log('\n── MuleSoft artifacts ────────────────────────────────');
  await seedGroup(MULESOFT_FILES, 'mulesoft', projectId, sourceId);

  // Seed TIBCO BW5
  console.log('\n── TIBCO BW5 artifacts ───────────────────────────────');
  await seedGroup(TIBCO_BW5_FILES, 'tibco', projectId, sourceId);

  // Seed TIBCO BW6
  console.log('\n── TIBCO BW6 artifacts ───────────────────────────────');
  await seedGroup(TIBCO_BW6_FILES, 'tibco', projectId, sourceId);

  await pool.end();
  console.log('\nDone. Test on Azure: open the app → select project "Real Artifact Tests" → convert any artifact.');
}

async function seedGroup(files, platform, projectId, sourceId) {
  for (const entry of files) {
    const filePath = path.join(BASE, entry.file);
    if (!fs.existsSync(filePath)) {
      console.log(`  SKIP (file not found): ${entry.file}`);
      continue;
    }
    const rawXml = fs.readFileSync(filePath, 'utf8');

    // Upsert by name + project_id — safe to re-run
    const res = await pool.query(
      `SELECT id FROM artifacts WHERE project_id = $1 AND name = $2 LIMIT 1`,
      [projectId, entry.name]
    );

    if (res.rows.length) {
      await pool.query(
        `UPDATE artifacts SET raw_xml=$1, artifact_type=$2, data_source='real' WHERE id=$3`,
        [rawXml, entry.artifact_type, res.rows[0].id]
      );
      console.log(`  UPDATED  ${entry.name} (id=${res.rows[0].id})`);
    } else {
      const ins = await pool.query(
        `INSERT INTO artifacts
           (project_id, source_id, name, platform, artifact_type,
            raw_xml, data_source, conversion_status, conversion_completeness, readiness, status)
         VALUES ($1,$2,$3,$4,$5,$6,'real','pending',0,'Manual','active') RETURNING id`,
        [projectId, sourceId, entry.name, platform, entry.artifact_type, rawXml]
      );
      console.log(`  INSERTED ${entry.name} (id=${ins.rows[0].id})`);
    }
  }
}

run().catch(err => { console.error(err); process.exit(1); });
