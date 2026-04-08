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

// ── Project 1: GlobalTech Manufacturing (Boomi) — 30 artifacts ─────────────
const boomiArtifacts = [
  art('SO_Create_SAP_from_Salesforce','CRM','boomi','Process','API',18,2,2,0,'basic',2,'Salesforce','Auto'),
  art('Payroll_Delta_SF_to_SAP_PY','HR','boomi','Process','Schedule',38,3,5,2,'multi_try_catch',6,'SAP SuccessFactors','Manual'),
  art('EDI_850_Inbound_PO','EXT','boomi','Process','Listener',41,3,5,3,'multi_try_catch',5,'AS2','Manual'),
  art('Customer_Master_Dist_Boomi','CRM','boomi','Process','Schedule',14,2,2,0,'basic',2,'SAP S/4HANA','Auto'),
  art('Invoice_Outbound_EDIFACT','FIN','boomi','Process','Event',32,3,4,1,'try_catch',4,'AS2','Partial'),
  art('Vendor_Master_Sync_Ariba','FIN','boomi','Process','Schedule',16,2,2,0,'basic',2,'SAP Ariba','Auto'),
  art('Material_Master_Dist','SCM','boomi','Process','Event',22,3,3,0,'basic',3,'SAP S/4HANA','Auto'),
  art('SalesOrder_Confirm_CRM','CRM','boomi','Process','API',12,2,1,0,'basic',1,'Salesforce','Auto'),
  art('GR_Notification_Ariba','SCM','boomi','Process','Event',19,2,2,1,'basic',2,'SAP Ariba','Partial'),
  art('Payment_Status_Update','FIN','boomi','Process','API',10,2,1,0,'basic',1,'SAP S/4HANA','Auto'),
  art('Employee_New_Hire_SF','HR','boomi','Process','Event',25,2,3,1,'try_catch',3,'SAP SuccessFactors','Partial'),
  art('Inventory_Level_Sync','SCM','boomi','Process','Schedule',20,3,2,0,'basic',2,'SAP S/4HANA','Auto'),
  art('Delivery_Tracking_Update','SCM','boomi','Process','API',15,2,2,0,'basic',1,'HTTP/REST','Auto'),
  art('EDI_856_ASN_Outbound','EXT','boomi','Process','Event',35,3,5,2,'multi_try_catch',5,'AS2','Manual'),
  art('PO_Change_Notification','SCM','boomi','Process','Event',18,2,2,1,'basic',2,'SAP Ariba','Partial'),
  art('Cost_Center_Hierarchy_Sync','FIN','boomi','Process','Schedule',9,1,1,0,'basic',1,'SAP S/4HANA','Auto'),
  art('HR_Org_Structure_Publish','HR','boomi','Process','Schedule',28,2,4,2,'try_catch',4,'SAP SuccessFactors','Partial'),
  art('Customer_Credit_Check','CRM','boomi','Process','API',13,2,2,0,'basic',1,'Salesforce','Auto'),
  art('Supplier_Invoice_Inbound','FIN','boomi','Process','Listener',33,3,4,1,'try_catch',4,'SFTP','Partial'),
  art('Product_Catalog_Sync','SCM','boomi','Process','Schedule',11,2,1,0,'basic',1,'HTTP/REST','Auto'),
  art('Sales_Quota_Upload','CRM','boomi','Process','API',8,1,1,0,'none',1,'Salesforce','Auto'),
  art('Payslip_Distribution','HR','boomi','Process','Schedule',24,2,3,1,'basic',3,'SFTP','Partial'),
  art('Bank_Statement_Recon','FIN','boomi','Process','Listener',40,3,5,3,'multi_try_catch',6,'SFTP','Manual'),
  art('Service_Order_Create','SCM','boomi','Process','API',21,3,3,1,'try_catch',3,'SAP S/4HANA','Partial'),
  art('Contract_Management_Sync','FIN','boomi','Process','Schedule',17,2,2,0,'basic',2,'SAP Ariba','Auto'),
  art('Warehouse_Transfer_Order','SCM','boomi','Process','Event',26,3,3,1,'try_catch',3,'SAP S/4HANA','Partial'),
  art('Customer_Returns_RMA','CRM','boomi','Process','API',19,2,2,1,'basic',2,'Salesforce','Partial'),
  art('GL_Journal_Posting','FIN','boomi','Process','Schedule',14,2,2,0,'basic',2,'SAP S/4HANA','Auto'),
  art('Production_Order_Status','SCM','boomi','Process','Event',22,2,2,1,'basic',2,'SAP S/4HANA','Partial'),
  art('EDI_810_Invoice_Outbound','EXT','boomi','Process','Event',37,3,5,3,'multi_try_catch',5,'AS2','Manual'),
];

// ── Project 2: ACME Logistics (PIPO) — 20 artifacts ───────────────────────
const pipoArtifacts = [
  art('Customer_Master_Distribution','CRM','pipo','IntegrationScenario','Event',14,2,1,0,'basic',1,'IDoc','Auto'),
  art('Purchase_Order_Inbound_EDI','SCM','pipo','IntegrationScenario','Listener',28,3,5,2,'try_catch',4,'AS2','Manual'),
  art('Invoice_Outbound_EDIFACT','FIN','pipo','IntegrationScenario','Event',32,3,5,2,'try_catch',4,'AS2','Manual'),
  art('Delivery_Notification_RFC','SCM','pipo','IntegrationScenario','API',12,2,1,0,'basic',1,'RFC','Auto'),
  art('HR_Employee_Sync_IDoc','HR','pipo','IntegrationScenario','Event',18,2,2,0,'basic',2,'IDoc','Auto'),
  art('Stock_Movement_Batch','SCM','pipo','IntegrationScenario','Schedule',20,2,2,1,'basic',2,'JDBC','Partial'),
  art('Sales_Order_Confirmation','CRM','pipo','IntegrationScenario','API',15,2,2,0,'basic',1,'HTTP/REST','Auto'),
  art('Payment_Status_Update_RFC','FIN','pipo','IntegrationScenario','API',10,2,1,0,'basic',1,'RFC','Auto'),
  art('Vendor_Master_Sync_PI','FIN','pipo','IntegrationScenario','Event',16,2,2,0,'basic',2,'IDoc','Auto'),
  art('Material_Master_Dist_Multi','SCM','pipo','IntegrationScenario','Event',24,3,3,1,'try_catch',3,'IDoc','Partial'),
  art('GR_GI_Notification','SCM','pipo','IntegrationScenario','Event',14,2,1,0,'basic',1,'IDoc','Auto'),
  art('Batch_Status_Monitoring','SCM','pipo','IntegrationScenario','Schedule',11,2,1,0,'basic',1,'HTTP/REST','Auto'),
  art('Finance_GL_Posting_IDoc','FIN','pipo','IntegrationScenario','Event',18,2,2,0,'basic',2,'IDoc','Auto'),
  art('Logistics_Invoice_Verify','FIN','pipo','IntegrationScenario','Event',22,2,2,1,'basic',2,'IDoc','Partial'),
  art('Customer_Order_Status_REST','CRM','pipo','IntegrationScenario','API',13,2,1,0,'basic',1,'HTTP/REST','Auto'),
  art('EDI_DESADV_Outbound','EXT','pipo','IntegrationScenario','Event',30,3,4,2,'try_catch',4,'AS2','Manual'),
  art('Tax_Reporting_Interface','FIN','pipo','IntegrationScenario','Schedule',16,2,2,1,'basic',2,'SFTP','Partial'),
  art('Production_MRP_Sync','SCM','pipo','IntegrationScenario','Schedule',21,3,3,1,'basic',2,'IDoc','Partial'),
  art('Quality_Notification_Sync','SCM','pipo','IntegrationScenario','Event',12,2,1,0,'basic',1,'IDoc','Auto'),
  art('Intercompany_Billing','FIN','pipo','IntegrationScenario','Event',26,3,3,2,'try_catch',3,'IDoc','Partial'),
];

// ── Project 3: TechCorp Digital (MuleSoft) — 18 artifacts ─────────────────
const mulesoftArtifacts = [
  art('Customer_360_API','CRM','mulesoft','Flow','API',22,3,3,2,'try_catch',3,'HTTP','Partial'),
  art('Loan_Application_Flow','FIN','mulesoft','Flow','API',35,4,4,3,'multi_try_catch',5,'HTTP','Manual'),
  art('Account_Statement_Batch','FIN','mulesoft','Batch','Schedule',28,3,4,2,'try_catch',4,'JDBC','Partial'),
  art('Payment_Notification_Event','FIN','mulesoft','Flow','Event',18,2,2,1,'basic',2,'Kafka','Partial'),
  art('Credit_Check_API','FIN','mulesoft','Flow','API',12,2,1,0,'basic',1,'HTTP','Auto'),
  art('Document_Archive_S3','INT','mulesoft','Flow','API',10,2,1,1,'basic',1,'S3','Auto'),
  art('Customer_Onboarding_Flow','CRM','mulesoft','Flow','API',30,3,3,2,'try_catch',3,'Salesforce','Partial'),
  art('Trade_Settlement_Batch','FIN','mulesoft','Batch','Schedule',42,4,5,3,'multi_try_catch',6,'JDBC','Manual'),
  art('Fraud_Detection_Event','FIN','mulesoft','Flow','Event',25,3,2,2,'try_catch',2,'Kafka','Partial'),
  art('KYC_Document_Check','CRM','mulesoft','Flow','API',19,2,2,1,'basic',2,'HTTP','Partial'),
  art('Interest_Calc_Scheduler','FIN','mulesoft','Flow','Schedule',14,2,1,1,'basic',1,'JDBC','Auto'),
  art('Regulatory_Report_File','FIN','mulesoft','Flow','Schedule',22,2,3,1,'basic',3,'SFTP','Partial'),
  art('Branch_Data_Sync','INT','mulesoft','Flow','Schedule',15,2,2,0,'basic',1,'HTTP','Auto'),
  art('Card_Transaction_Listener','FIN','mulesoft','Flow','Listener',20,2,2,1,'try_catch',2,'JMS','Partial'),
  art('Customer_Profile_Update','CRM','mulesoft','Flow','API',11,2,1,0,'basic',1,'Salesforce','Auto'),
  art('ATM_Network_Integration','FIN','mulesoft','Flow','Event',32,3,3,2,'try_catch',3,'JMS','Partial'),
  art('Mortgage_Pipeline_Sync','FIN','mulesoft','Flow','Schedule',26,3,3,2,'try_catch',3,'JDBC','Partial'),
  art('Insurance_Claim_Flow','FIN','mulesoft','Flow','API',38,4,4,3,'multi_try_catch',5,'HTTP','Manual'),
];

// ── Project 4: RetailCo Operations (TIBCO BW) — 22 artifacts ──────────────
const tibcoArtifacts = [
  art('OrderFulfillment_Orchestration','SCM','tibco','ProcessDef','API',28,3,3,2,'try_catch',3,'HTTP','Partial'),
  art('InventoryLevel_Sync_Batch','SCM','tibco','ProcessDef','Schedule',22,2,2,0,'basic',2,'JDBC','Auto'),
  art('CustomerLoyalty_Event_Process','CRM','tibco','ProcessDef','Event',18,2,2,1,'basic',2,'JMS','Partial'),
  art('POS_Transaction_Inbound','INT','tibco','ProcessDef','Listener',24,3,3,1,'try_catch',3,'SFTP','Partial'),
  art('Supplier_EDI_Processing','EXT','tibco','ProcessDef','Listener',40,3,5,3,'multi_try_catch',5,'AS2','Manual'),
  art('Store_Replenishment_API','SCM','tibco','ProcessDef','API',16,2,2,0,'basic',1,'HTTP','Auto'),
  art('Price_Update_Broadcast','SCM','tibco','ProcessDef','Event',14,2,1,0,'basic',1,'JMS','Auto'),
  art('Customer_Returns_Process','CRM','tibco','ProcessDef','API',20,2,2,1,'basic',2,'HTTP','Partial'),
  art('Finance_GL_Interface','FIN','tibco','ProcessDef','Schedule',25,3,3,1,'try_catch',3,'JDBC','Partial'),
  art('Loyalty_Points_Calc','CRM','tibco','ProcessDef','Event',19,2,2,1,'basic',2,'JMS','Partial'),
  art('Warehouse_Pick_Ticket','SCM','tibco','ProcessDef','Event',17,2,2,0,'basic',2,'JMS','Auto'),
  art('Supplier_Invoice_Match','FIN','tibco','ProcessDef','Event',30,3,3,2,'try_catch',3,'SFTP','Partial'),
  art('Campaign_Trigger_Event','CRM','tibco','ProcessDef','Event',12,2,1,0,'basic',1,'JMS','Auto'),
  art('Stock_Count_Reconcile','SCM','tibco','ProcessDef','Schedule',21,2,2,1,'basic',2,'JDBC','Partial'),
  art('Order_Status_Notification','SCM','tibco','ProcessDef','Event',13,2,1,0,'basic',1,'SMTP','Auto'),
  art('EDI_855_PO_Acknowledgement','EXT','tibco','ProcessDef','Event',33,3,4,2,'try_catch',4,'AS2','Manual'),
  art('HR_Payroll_Interface','HR','tibco','ProcessDef','Schedule',28,2,3,1,'basic',3,'SFTP','Partial'),
  art('Cash_Register_Sync','INT','tibco','ProcessDef','Schedule',15,2,1,0,'basic',1,'JDBC','Auto'),
  art('Product_Taxonomy_Update','SCM','tibco','ProcessDef','Schedule',11,2,1,0,'basic',1,'HTTP','Auto'),
  art('Return_Auth_Processing','CRM','tibco','ProcessDef','API',22,2,2,1,'try_catch',2,'HTTP','Partial'),
  art('Vendor_Payment_Batch','FIN','tibco','ProcessDef','Schedule',35,3,4,2,'try_catch',4,'SFTP','Partial'),
  art('Cross_Channel_Order_Merge','SCM','tibco','ProcessDef','Event',38,4,4,3,'multi_try_catch',5,'JMS','Manual'),
];

async function runSeed() {
  await initDb();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clear existing seed data
    await client.query("DELETE FROM projects WHERE name IN ('GlobalTech Manufacturing','ACME Logistics','TechCorp Digital','RetailCo Operations')");

    // Insert Project 1 — Boomi
    const p1 = await client.query(
      `INSERT INTO projects (name, customer, consultant, platform, description, status)
       VALUES ('GlobalTech Manufacturing','GlobalTech Industries Inc.','Sriman Parisuchitha','boomi','Boomi AtomSphere to SAP Integration Suite migration — 30 integration processes across CRM, HR, Finance, and Supply Chain domains. Phase 1 of 3-year digital transformation program.','active')
       RETURNING id`
    );
    const p1id = p1.rows[0].id;

    const sc1 = await client.query(
      `INSERT INTO source_connections (project_id, type, name, platform, config, status, artifacts_found, last_synced_at)
       VALUES ($1,'api','Boomi AtomSphere — PROD','boomi','{"accountId":"globaltech-prod","environment":"Production","authentication":"Basic Auth"}','synced',30,NOW())
       RETURNING id`,
      [p1id]
    );
    const sc1id = sc1.rows[0].id;

    for (const a of boomiArtifacts) {
      await client.query(
        `INSERT INTO artifacts (source_id,project_id,process_id,name,domain,platform,artifact_type,trigger_type,shapes_count,connectors_count,maps_count,has_scripting,scripting_detail,error_handling,dependencies_count,primary_connector,complexity_score,complexity_level,tshirt_size,effort_days,readiness,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'discovered')`,
        [sc1id,p1id,`boomi-p1-${a.name.replace(/\s+/g,'_')}`,a.name,a.domain,a.platform,a.artifact_type,a.trigger_type,a.shapes_count,a.connectors_count,a.maps_count,a.has_scripting,a.scripting_detail,a.error_handling,a.dependencies_count,a.primary_connector,a.complexity_score,a.complexity_level,a.tshirt_size,a.effort_days,a.readiness]
      );
    }

    // Insert Project 2 — PIPO
    const p2 = await client.query(
      `INSERT INTO projects (name, customer, consultant, platform, description, status)
       VALUES ('ACME Logistics','ACME Logistics GmbH','Priya Sharma','pipo','SAP PI/PO 7.5 to SAP Integration Suite migration — 20 integration scenarios for logistics and supply chain. Customer running SAP ERP ECC 6.0 with plans to migrate to S/4HANA post-integration modernization.','active')
       RETURNING id`
    );
    const p2id = p2.rows[0].id;

    const sc2 = await client.query(
      `INSERT INTO source_connections (project_id, type, name, platform, config, status, artifacts_found, last_synced_at)
       VALUES ($1,'zip','SAP PI 7.5 Export — XI Repository','pipo','{"filename":"pi75_export.zip","size":4200000}','synced',20,NOW())
       RETURNING id`,
      [p2id]
    );
    const sc2id = sc2.rows[0].id;

    for (const a of pipoArtifacts) {
      await client.query(
        `INSERT INTO artifacts (source_id,project_id,process_id,name,domain,platform,artifact_type,trigger_type,shapes_count,connectors_count,maps_count,has_scripting,scripting_detail,error_handling,dependencies_count,primary_connector,complexity_score,complexity_level,tshirt_size,effort_days,readiness,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'discovered')`,
        [sc2id,p2id,`pipo-p2-${a.name.replace(/\s+/g,'_')}`,a.name,a.domain,a.platform,a.artifact_type,a.trigger_type,a.shapes_count,a.connectors_count,a.maps_count,a.has_scripting,a.scripting_detail,a.error_handling,a.dependencies_count,a.primary_connector,a.complexity_score,a.complexity_level,a.tshirt_size,a.effort_days,a.readiness]
      );
    }

    // Insert Project 3 — MuleSoft
    const p3 = await client.query(
      `INSERT INTO projects (name, customer, consultant, platform, description, status)
       VALUES ('TechCorp Digital','TechCorp Financial Services Ltd.','Raj Patel','mulesoft','MuleSoft Anypoint Platform to SAP Integration Suite migration — 18 API-led integration flows for a fintech company. Customer consolidating on SAP BTP after MuleSoft contract renewal decision.','active')
       RETURNING id`
    );
    const p3id = p3.rows[0].id;

    const sc3 = await client.query(
      `INSERT INTO source_connections (project_id, type, name, platform, config, status, artifacts_found, last_synced_at)
       VALUES ($1,'zip','MuleSoft Anypoint — mule-config export','mulesoft','{"filename":"mulesoft_config.xml","size":3100000}','synced',18,NOW())
       RETURNING id`,
      [p3id]
    );
    const sc3id = sc3.rows[0].id;

    for (const a of mulesoftArtifacts) {
      await client.query(
        `INSERT INTO artifacts (source_id,project_id,process_id,name,domain,platform,artifact_type,trigger_type,shapes_count,connectors_count,maps_count,has_scripting,scripting_detail,error_handling,dependencies_count,primary_connector,complexity_score,complexity_level,tshirt_size,effort_days,readiness,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'discovered')`,
        [sc3id,p3id,`mule-p3-${a.name.replace(/\s+/g,'_')}`,a.name,a.domain,a.platform,a.artifact_type,a.trigger_type,a.shapes_count,a.connectors_count,a.maps_count,a.has_scripting,a.scripting_detail,a.error_handling,a.dependencies_count,a.primary_connector,a.complexity_score,a.complexity_level,a.tshirt_size,a.effort_days,a.readiness]
      );
    }

    // Insert Project 4 — TIBCO
    const p4 = await client.query(
      `INSERT INTO projects (name, customer, consultant, platform, description, status)
       VALUES ('RetailCo Operations','RetailCo International PLC','Anika Gupta','tibco','TIBCO BusinessWorks 5.x to SAP Integration Suite migration — 22 integration processes for a multinational retail company. End-of-life TIBCO BW license driving migration timeline.','active')
       RETURNING id`
    );
    const p4id = p4.rows[0].id;

    const sc4 = await client.query(
      `INSERT INTO source_connections (project_id, type, name, platform, config, status, artifacts_found, last_synced_at)
       VALUES ($1,'zip','TIBCO BW 5.x Project Export','tibco','{"filename":"tibco_bw_project.zip","size":5800000}','synced',22,NOW())
       RETURNING id`,
      [p4id]
    );
    const sc4id = sc4.rows[0].id;

    for (const a of tibcoArtifacts) {
      await client.query(
        `INSERT INTO artifacts (source_id,project_id,process_id,name,domain,platform,artifact_type,trigger_type,shapes_count,connectors_count,maps_count,has_scripting,scripting_detail,error_handling,dependencies_count,primary_connector,complexity_score,complexity_level,tshirt_size,effort_days,readiness,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'discovered')`,
        [sc4id,p4id,`tibco-p4-${a.name.replace(/\s+/g,'_')}`,a.name,a.domain,a.platform,a.artifact_type,a.trigger_type,a.shapes_count,a.connectors_count,a.maps_count,a.has_scripting,a.scripting_detail,a.error_handling,a.dependencies_count,a.primary_connector,a.complexity_score,a.complexity_level,a.tshirt_size,a.effort_days,a.readiness]
      );
    }

    await client.query('COMMIT');

    const total = boomiArtifacts.length + pipoArtifacts.length + mulesoftArtifacts.length + tibcoArtifacts.length;
    console.log(`Seed complete: 4 projects, ${total} artifacts inserted.`);
    console.log(`  Project 1 (Boomi):    ${boomiArtifacts.length} artifacts`);
    console.log(`  Project 2 (PIPO):     ${pipoArtifacts.length} artifacts`);
    console.log(`  Project 3 (MuleSoft): ${mulesoftArtifacts.length} artifacts`);
    console.log(`  Project 4 (TIBCO):    ${tibcoArtifacts.length} artifacts`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runSeed };

// Run directly if called as script
if (require.main === module) {
  runSeed()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}
