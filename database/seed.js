require('dotenv').config();
const { pool, initDb } = require('./db');

// ── Complexity Scoring (inline for seed independence) ──────────────────────

function computeRawScore(param, value) {
  switch (param) {
    case 'shapes': if (value <= 5) return 2; if (value <= 10) return 4; if (value <= 20) return 6; if (value <= 35) return 8; return 10;
    case 'connectors': if (value <= 1) return 2; if (value <= 2) return 4; if (value <= 3) return 6; if (value <= 4) return 8; return 10;
    case 'maps': return [0,2,4,6,8,10][Math.min(value,5)];
    case 'scripting': if (value === 0) return 0; if (value === 1) return 3; if (value === 2) return 6; return 10;
    case 'error_handling': if (value === 0) return 1; if (value === 1) return 3; if (value === 2) return 6; return 10;
    case 'dependencies': if (value === 0) return 0; if (value <= 2) return 3; if (value <= 4) return 6; return 10;
    default: return 0;
  }
}

function score(s, c, m, sc, e, d) {
  const raw = computeRawScore('shapes',s)*1.5 + computeRawScore('connectors',c)*2 + computeRawScore('maps',m)*2.5 + computeRawScore('scripting',sc)*2 + computeRawScore('error_handling',e)*1 + computeRawScore('dependencies',d)*1;
  const maxRaw = 10*1.5+10*2+10*2.5+10*2+10*1+10*1;
  return Math.round((raw/maxRaw)*100);
}

function classify(sc) {
  if (sc <= 20) return { level:'Simple', tshirt:'XS', effort:1 };
  if (sc <= 34) return { level:'Simple', tshirt:'S', effort:2 };
  if (sc <= 64) return { level:'Medium', tshirt:'M', effort:5 };
  if (sc <= 79) return { level:'Complex', tshirt:'L', effort:12 };
  return { level:'Complex', tshirt:'XL', effort:18 };
}

function art(name, domain, platform, type, trigger, shapes, conns, maps, scripting, errh, deps, connector, readiness) {
  const mapComp = maps > 4 ? 4 : maps > 2 ? 3 : maps > 1 ? 2 : maps > 0 ? 1 : 0;
  const scriptLvl = scripting === 3 ? 3 : scripting === 2 ? 2 : scripting === 1 ? 1 : 0;
  const errLvl = errh === 'multi_try_catch' ? 3 : errh === 'try_catch' ? 2 : errh === 'basic' ? 1 : 0;
  const sc = score(shapes, conns, mapComp, scriptLvl, errLvl, deps);
  const cl = classify(sc);
  return {
    name, domain, platform, artifact_type: type, trigger_type: trigger,
    shapes_count: shapes, connectors_count: conns, maps_count: maps,
    has_scripting: scripting > 0, scripting_detail: scripting > 0 ? `${scripting} script(s)` : null,
    error_handling: errh, dependencies_count: deps, primary_connector: connector,
    complexity_score: sc, complexity_level: cl.level, tshirt_size: cl.tshirt, effort_days: cl.effort,
    readiness: readiness || (scripting > 1 ? 'Manual' : sc > 55 ? 'Partial' : 'Auto')
  };
}

// ── Project 1: SLB Field Operations Integration (Boomi) — 30 artifacts ───────
// Domains: Drilling, Well Data, Field Services, Assets, HSE, Supply Chain, Finance
const boomiArtifacts = [
  // ── Drilling & Well Data
  art('Well_Telemetry_RT_Inbound',       'Drilling',       'boomi','Process','Listener', 42,4,5,3,'multi_try_catch',6,'HTTP/REST',  'Manual'),
  art('Drilling_Report_Daily_SAP_PM',    'Drilling',       'boomi','Process','Schedule', 28,3,4,2,'try_catch',      4,'SAP S/4HANA','Partial'),
  art('Wellbore_Log_Data_Transfer',      'Drilling',       'boomi','Process','Event',    24,3,3,1,'try_catch',      3,'SFTP',       'Partial'),
  art('Well_Completion_Status_Notify',   'Drilling',       'boomi','Process','Event',    14,2,2,0,'basic',          2,'HTTP/REST',  'Auto'),
  art('Mud_Log_Data_SAP_Ingest',         'Drilling',       'boomi','Process','Listener', 32,3,4,2,'try_catch',      4,'SFTP',       'Partial'),
  art('Subsurface_Data_SAP_PM_Sync',     'Drilling',       'boomi','Process','Schedule', 38,4,5,3,'multi_try_catch',5,'SAP S/4HANA','Manual'),
  art('Drill_Bit_Performance_Monitor',   'Drilling',       'boomi','Process','Event',    22,3,3,2,'try_catch',      3,'HTTP/REST',  'Partial'),

  // ── Field Services
  art('Field_Service_Order_SAP_Sync',    'Field Services', 'boomi','Process','API',      26,3,3,1,'try_catch',      3,'SAP S/4HANA','Partial'),
  art('Technician_Dispatch_Integration', 'Field Services', 'boomi','Process','Event',    18,2,2,1,'basic',          2,'HTTP/REST',  'Partial'),
  art('Work_Order_Completion_Update',    'Field Services', 'boomi','Process','API',      20,3,2,1,'basic',          2,'SAP S/4HANA','Partial'),
  art('Rig_Crew_Schedule_Integration',   'Field Services', 'boomi','Process','Schedule', 25,3,3,2,'try_catch',      3,'HTTP/REST',  'Partial'),
  art('Field_Equipment_Checkout_Track',  'Field Services', 'boomi','Process','API',      12,2,1,0,'basic',          1,'HTTP/REST',  'Auto'),

  // ── Asset & Equipment Management
  art('Equipment_Asset_Registry_SAP',    'Assets',         'boomi','Process','Schedule', 22,2,3,1,'basic',          3,'SAP S/4HANA','Partial'),
  art('Preventive_Maintenance_SAP_PM',   'Assets',         'boomi','Process','Event',    16,2,2,0,'basic',          2,'SAP S/4HANA','Auto'),
  art('Rig_Asset_Transfer_Notification', 'Assets',         'boomi','Process','Event',    13,2,1,0,'basic',          1,'HTTP/REST',  'Auto'),
  art('Equipment_Certification_Sync',    'Assets',         'boomi','Process','Schedule', 19,2,2,1,'basic',          2,'SFTP',       'Partial'),
  art('Rotating_Equipment_MTTR_Sync',    'Assets',         'boomi','Process','Schedule', 35,3,4,2,'try_catch',      4,'SAP S/4HANA','Manual'),

  // ── Supply Chain & Procurement
  art('Spare_Parts_Requisition_PO',      'Supply Chain',   'boomi','Process','Event',    24,3,3,1,'try_catch',      3,'SAP Ariba',  'Partial'),
  art('Vendor_Invoice_AP_Processing',    'Supply Chain',   'boomi','Process','Listener', 40,3,5,3,'multi_try_catch',5,'SFTP',       'Manual'),
  art('Warehouse_Parts_Inventory_Sync',  'Supply Chain',   'boomi','Process','Schedule', 20,2,2,0,'basic',          2,'SAP S/4HANA','Auto'),
  art('Chemicals_Inventory_Alert',       'Supply Chain',   'boomi','Process','Event',    11,2,1,0,'basic',          1,'HTTP/REST',  'Auto'),
  art('Drilling_Consumables_PO_Sync',    'Supply Chain',   'boomi','Process','Event',    22,3,3,1,'basic',          3,'SAP Ariba',  'Partial'),
  art('Supplier_GR_Confirmation',        'Supply Chain',   'boomi','Process','Event',    15,2,2,0,'basic',          2,'SAP Ariba',  'Auto'),

  // ── Finance
  art('Project_Cost_Capture_SAP_WBS',    'Finance',        'boomi','Process','Schedule', 26,3,3,1,'try_catch',      3,'SAP S/4HANA','Partial'),
  art('Revenue_Recognition_WBS_Sync',    'Finance',        'boomi','Process','Schedule', 38,3,5,3,'multi_try_catch',5,'SAP S/4HANA','Manual'),
  art('AFE_Budget_Approval_Flow',        'Finance',        'boomi','Process','API',      20,3,2,1,'try_catch',      2,'SAP S/4HANA','Partial'),
  art('Intercompany_Recharge_Sync',      'Finance',        'boomi','Process','Schedule', 18,2,2,0,'basic',          2,'SAP S/4HANA','Auto'),

  // ── HSE (Health, Safety & Environment)
  art('HSE_Incident_Report_Integration', 'HSE',            'boomi','Process','API',      24,3,3,2,'try_catch',      3,'HTTP/REST',  'Partial'),
  art('Safety_Observation_Sync',         'HSE',            'boomi','Process','Event',    14,2,1,0,'basic',          1,'HTTP/REST',  'Auto'),
  art('Emergency_Response_Alert',        'HSE',            'boomi','Process','Event',    10,2,1,1,'basic',          1,'SMTP',       'Auto'),
];

// ── Project 2: SLB Enterprise Services Integration (TIBCO BW) — 22 artifacts ─
// Domains: Finance, HR, Procurement, Logistics, Reporting
const tibcoArtifacts = [
  // ── Finance
  art('SAP_GL_Journal_Entry_Sync',       'Finance',        'tibco','ProcessDef','Schedule', 26,3,3,1,'try_catch',      3,'JDBC',       'Partial'),
  art('AP_Invoice_Workflow_3Way_Match',  'Finance',        'tibco','ProcessDef','Listener', 42,4,5,3,'multi_try_catch',6,'SFTP',       'Manual'),
  art('Project_Billing_Revenue_Export',  'Finance',        'tibco','ProcessDef','Schedule', 28,3,4,2,'try_catch',      4,'SAP S/4HANA','Partial'),
  art('Cost_Center_Budget_Allocation',   'Finance',        'tibco','ProcessDef','Schedule',  9,1,1,0,'basic',          1,'JDBC',       'Auto'),
  art('Treasury_FX_Rate_Integration',    'Finance',        'tibco','ProcessDef','Schedule', 22,2,3,1,'basic',          2,'HTTP/REST',  'Partial'),
  art('Fixed_Assets_Depreciation_Sync',  'Finance',        'tibco','ProcessDef','Schedule', 18,2,2,0,'basic',          2,'SAP S/4HANA','Auto'),
  art('Tax_Compliance_Reporting_SFTP',   'Finance',        'tibco','ProcessDef','Schedule', 24,2,3,1,'basic',          3,'SFTP',       'Partial'),

  // ── HR & Workforce
  art('Workforce_Onboarding_Integration','HR',             'tibco','ProcessDef','API',      30,3,3,2,'try_catch',      3,'SAP SuccessFactors','Partial'),
  art('Leave_Absence_Management_Sync',   'HR',             'tibco','ProcessDef','Event',    16,2,2,0,'basic',          2,'SAP SuccessFactors','Auto'),
  art('Payroll_Delta_SF_SAP_PY',         'HR',             'tibco','ProcessDef','Schedule', 38,3,5,3,'multi_try_catch',5,'SAP SuccessFactors','Manual'),
  art('Training_Certification_Track',    'HR',             'tibco','ProcessDef','Schedule', 14,2,1,0,'basic',          1,'HTTP/REST',  'Auto'),
  art('Org_Structure_Headcount_Publish', 'HR',             'tibco','ProcessDef','Schedule', 22,2,2,1,'basic',          2,'SAP SuccessFactors','Partial'),

  // ── Procurement
  art('Procurement_PO_Ariba_SAP_Sync',   'Procurement',    'tibco','ProcessDef','Event',    24,3,3,1,'try_catch',      3,'SAP Ariba',  'Partial'),
  art('Supplier_Master_Data_Dist',       'Procurement',    'tibco','ProcessDef','Schedule', 13,2,1,0,'basic',          1,'SAP S/4HANA','Auto'),
  art('Contract_Lifecycle_SAP_Sync',     'Procurement',    'tibco','ProcessDef','Schedule', 20,2,2,1,'basic',          2,'SAP Ariba',  'Partial'),
  art('EDI_850_Supplier_PO_Outbound',    'Procurement',    'tibco','ProcessDef','Event',    36,3,5,2,'multi_try_catch',5,'AS2',        'Manual'),

  // ── Logistics
  art('Logistics_Freight_Cost_Tracking', 'Logistics',      'tibco','ProcessDef','API',      22,3,2,1,'try_catch',      2,'HTTP/REST',  'Partial'),
  art('Customs_Clearance_Integration',   'Logistics',      'tibco','ProcessDef','Event',    25,3,3,2,'try_catch',      3,'HTTP/REST',  'Partial'),
  art('Rig_Mobilization_Logistics_Sync', 'Logistics',      'tibco','ProcessDef','Schedule', 28,3,3,2,'try_catch',      3,'SAP S/4HANA','Partial'),
  art('Port_Demurrage_Alert_Flow',       'Logistics',      'tibco','ProcessDef','Event',    12,2,1,0,'basic',          1,'SMTP',       'Auto'),

  // ── Reporting & Analytics
  art('Operations_KPI_Dashboard_Feed',   'Reporting',      'tibco','ProcessDef','Schedule', 16,2,2,1,'basic',          2,'HTTP/REST',  'Partial'),
  art('Production_Volume_Report_Sync',   'Reporting',      'tibco','ProcessDef','Schedule', 20,2,3,1,'basic',          2,'SFTP',       'Partial'),
];

// ── Seed project names (used for targeted DELETE on re-seed) ─────────────────
const SLB_PROJECT_NAMES = [
  'SLB Field Operations Integration',
  'SLB Enterprise Services Integration'
];

async function runSeed(force = false) {
  await initDb();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (force) {
      // Force reseed: wipe all projects (and cascade artifacts via FK)
      await client.query('DELETE FROM projects');
    } else {
      // Normal seed: only remove SLB projects (idempotent)
      await client.query(`DELETE FROM projects WHERE name = ANY($1)`, [SLB_PROJECT_NAMES]);
    }

    // ── Project 1: SLB Field Operations Integration (Boomi) ──────────────────
    const p1 = await client.query(
      `INSERT INTO projects (name, customer, consultant, platform, description, status)
       VALUES ($1,$2,$3,$4,$5,'active') RETURNING id`,
      [
        'SLB Field Operations Integration',
        'SLB (Schlumberger)',
        'Sriman Parisuchitha',
        'boomi',
        'Boomi AtomSphere to SAP Integration Suite migration — 30 integration processes spanning Drilling, Well Data, Field Services, Asset Management, HSE, and Supply Chain. SLB is consolidating on SAP BTP as part of their global digital transformation initiative to modernize integration infrastructure across 120+ countries.'
      ]
    );
    const p1id = p1.rows[0].id;

    const sc1 = await client.query(
      `INSERT INTO source_connections (project_id, type, name, platform, config, status, artifacts_found, last_synced_at)
       VALUES ($1,'api','SLB Boomi AtomSphere — PROD','boomi','{"accountId":"slb-prod-us","environment":"Production","authentication":"Basic Auth","region":"US-East"}','synced',30,NOW())
       RETURNING id`,
      [p1id]
    );
    const sc1id = sc1.rows[0].id;

    for (const a of boomiArtifacts) {
      await client.query(
        `INSERT INTO artifacts (source_id,project_id,process_id,name,domain,platform,artifact_type,trigger_type,
          shapes_count,connectors_count,maps_count,has_scripting,scripting_detail,error_handling,
          dependencies_count,primary_connector,complexity_score,complexity_level,tshirt_size,effort_days,readiness,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'discovered')`,
        [sc1id,p1id,`boomi-slb-${a.name}`,a.name,a.domain,a.platform,a.artifact_type,a.trigger_type,
         a.shapes_count,a.connectors_count,a.maps_count,a.has_scripting,a.scripting_detail,a.error_handling,
         a.dependencies_count,a.primary_connector,a.complexity_score,a.complexity_level,a.tshirt_size,a.effort_days,a.readiness]
      );
    }

    // ── Project 2: SLB Enterprise Services Integration (TIBCO) ───────────────
    const p2 = await client.query(
      `INSERT INTO projects (name, customer, consultant, platform, description, status)
       VALUES ($1,$2,$3,$4,$5,'active') RETURNING id`,
      [
        'SLB Enterprise Services Integration',
        'SLB (Schlumberger)',
        'Sriman Parisuchitha',
        'tibco',
        'TIBCO BusinessWorks 5.x to SAP Integration Suite migration — 22 enterprise integration processes across Finance, HR, Procurement, Logistics, and Reporting. End-of-life TIBCO BW license and SAP S/4HANA adoption driving migration to SAP BTP Integration Suite.'
      ]
    );
    const p2id = p2.rows[0].id;

    const sc2 = await client.query(
      `INSERT INTO source_connections (project_id, type, name, platform, config, status, artifacts_found, last_synced_at)
       VALUES ($1,'zip','SLB TIBCO BW 5.x Project Export','tibco','{"filename":"slb_tibco_bw_project.zip","size":6200000,"bwVersion":"5.14","designer":"TIBCO Designer"}','synced',22,NOW())
       RETURNING id`,
      [p2id]
    );
    const sc2id = sc2.rows[0].id;

    for (const a of tibcoArtifacts) {
      await client.query(
        `INSERT INTO artifacts (source_id,project_id,process_id,name,domain,platform,artifact_type,trigger_type,
          shapes_count,connectors_count,maps_count,has_scripting,scripting_detail,error_handling,
          dependencies_count,primary_connector,complexity_score,complexity_level,tshirt_size,effort_days,readiness,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'discovered')`,
        [sc2id,p2id,`tibco-slb-${a.name}`,a.name,a.domain,a.platform,a.artifact_type,a.trigger_type,
         a.shapes_count,a.connectors_count,a.maps_count,a.has_scripting,a.scripting_detail,a.error_handling,
         a.dependencies_count,a.primary_connector,a.complexity_score,a.complexity_level,a.tshirt_size,a.effort_days,a.readiness]
      );
    }

    await client.query('COMMIT');

    const total = boomiArtifacts.length + tibcoArtifacts.length;
    console.log(`Seed complete: 2 SLB projects, ${total} artifacts inserted.`);
    console.log(`  Project 1 — SLB Field Operations (Boomi):       ${boomiArtifacts.length} artifacts`);
    console.log(`  Project 2 — SLB Enterprise Services (TIBCO BW): ${tibcoArtifacts.length} artifacts`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runSeed, SLB_PROJECT_NAMES };

if (require.main === module) {
  const force = process.argv.includes('--force');
  runSeed(force)
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}
