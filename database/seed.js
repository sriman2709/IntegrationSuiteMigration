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

// ════════════════════════════════════════════════════════════════════════════
// ── SLB-SPECIFIC PROJECTS (demo-ready for SLB Schlumberger)
// ════════════════════════════════════════════════════════════════════════════

// ── SLB Project 1: SLB Field Operations Integration (Boomi) — 30 artifacts ─
const slbBoomiArtifacts = [
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

// ── SLB Project 2: SLB Enterprise Services Integration (TIBCO BW) — 22 artifacts
const slbTibcoArtifacts = [
  // ── Finance
  art('SAP_GL_Journal_Entry_Sync',       'Finance',        'tibco','ProcessDef','Schedule', 26,3,3,1,'try_catch',      3,'JDBC',               'Partial'),
  art('AP_Invoice_Workflow_3Way_Match',  'Finance',        'tibco','ProcessDef','Listener', 42,4,5,3,'multi_try_catch',6,'SFTP',               'Manual'),
  art('Project_Billing_Revenue_Export',  'Finance',        'tibco','ProcessDef','Schedule', 28,3,4,2,'try_catch',      4,'SAP S/4HANA',        'Partial'),
  art('Cost_Center_Budget_Allocation',   'Finance',        'tibco','ProcessDef','Schedule',  9,1,1,0,'basic',          1,'JDBC',               'Auto'),
  art('Treasury_FX_Rate_Integration',    'Finance',        'tibco','ProcessDef','Schedule', 22,2,3,1,'basic',          2,'HTTP/REST',          'Partial'),
  art('Fixed_Assets_Depreciation_Sync',  'Finance',        'tibco','ProcessDef','Schedule', 18,2,2,0,'basic',          2,'SAP S/4HANA',        'Auto'),
  art('Tax_Compliance_Reporting_SFTP',   'Finance',        'tibco','ProcessDef','Schedule', 24,2,3,1,'basic',          3,'SFTP',               'Partial'),
  // ── HR & Workforce
  art('Workforce_Onboarding_Integration','HR',             'tibco','ProcessDef','API',      30,3,3,2,'try_catch',      3,'SAP SuccessFactors', 'Partial'),
  art('Leave_Absence_Management_Sync',   'HR',             'tibco','ProcessDef','Event',    16,2,2,0,'basic',          2,'SAP SuccessFactors', 'Auto'),
  art('Payroll_Delta_SF_SAP_PY',         'HR',             'tibco','ProcessDef','Schedule', 38,3,5,3,'multi_try_catch',5,'SAP SuccessFactors', 'Manual'),
  art('Training_Certification_Track',    'HR',             'tibco','ProcessDef','Schedule', 14,2,1,0,'basic',          1,'HTTP/REST',          'Auto'),
  art('Org_Structure_Headcount_Publish', 'HR',             'tibco','ProcessDef','Schedule', 22,2,2,1,'basic',          2,'SAP SuccessFactors', 'Partial'),
  // ── Procurement
  art('Procurement_PO_Ariba_SAP_Sync',   'Procurement',    'tibco','ProcessDef','Event',    24,3,3,1,'try_catch',      3,'SAP Ariba',          'Partial'),
  art('Supplier_Master_Data_Dist',       'Procurement',    'tibco','ProcessDef','Schedule', 13,2,1,0,'basic',          1,'SAP S/4HANA',        'Auto'),
  art('Contract_Lifecycle_SAP_Sync',     'Procurement',    'tibco','ProcessDef','Schedule', 20,2,2,1,'basic',          2,'SAP Ariba',          'Partial'),
  art('EDI_850_Supplier_PO_Outbound',    'Procurement',    'tibco','ProcessDef','Event',    36,3,5,2,'multi_try_catch',5,'AS2',                'Manual'),
  // ── Logistics
  art('Logistics_Freight_Cost_Tracking', 'Logistics',      'tibco','ProcessDef','API',      22,3,2,1,'try_catch',      2,'HTTP/REST',          'Partial'),
  art('Customs_Clearance_Integration',   'Logistics',      'tibco','ProcessDef','Event',    25,3,3,2,'try_catch',      3,'HTTP/REST',          'Partial'),
  art('Rig_Mobilization_Logistics_Sync', 'Logistics',      'tibco','ProcessDef','Schedule', 28,3,3,2,'try_catch',      3,'SAP S/4HANA',        'Partial'),
  art('Port_Demurrage_Alert_Flow',       'Logistics',      'tibco','ProcessDef','Event',    12,2,1,0,'basic',          1,'SMTP',               'Auto'),
  // ── Reporting & Analytics
  art('Operations_KPI_Dashboard_Feed',   'Reporting',      'tibco','ProcessDef','Schedule', 16,2,2,1,'basic',          2,'HTTP/REST',          'Partial'),
  art('Production_Volume_Report_Sync',   'Reporting',      'tibco','ProcessDef','Schedule', 20,2,3,1,'basic',          2,'SFTP',               'Partial'),
];

// ════════════════════════════════════════════════════════════════════════════
// ── GENERIC DEMO PROJECTS (multi-industry showcase)
// ════════════════════════════════════════════════════════════════════════════

// ── Demo Project 1: GlobalTech Manufacturing (Boomi) — 30 artifacts ────────
const globalTechArtifacts = [
  art('SO_Create_SAP_from_Salesforce',   'CRM',  'boomi','Process','API',      18,2,2,0,'basic',          2,'Salesforce',          'Auto'),
  art('Payroll_Delta_SF_to_SAP_PY',      'HR',   'boomi','Process','Schedule', 38,3,5,2,'multi_try_catch',6,'SAP SuccessFactors',   'Manual'),
  art('EDI_850_Inbound_PO',              'EXT',  'boomi','Process','Listener', 41,3,5,3,'multi_try_catch',5,'AS2',                  'Manual'),
  art('Customer_Master_Dist_Boomi',      'CRM',  'boomi','Process','Schedule', 14,2,2,0,'basic',          2,'SAP S/4HANA',         'Auto'),
  art('Invoice_Outbound_EDIFACT',        'FIN',  'boomi','Process','Event',    32,3,4,1,'try_catch',      4,'AS2',                 'Partial'),
  art('Vendor_Master_Sync_Ariba',        'FIN',  'boomi','Process','Schedule', 16,2,2,0,'basic',          2,'SAP Ariba',           'Auto'),
  art('Material_Master_Dist',            'SCM',  'boomi','Process','Event',    22,3,3,0,'basic',          3,'SAP S/4HANA',         'Auto'),
  art('SalesOrder_Confirm_CRM',          'CRM',  'boomi','Process','API',      12,2,1,0,'basic',          1,'Salesforce',          'Auto'),
  art('GR_Notification_Ariba',           'SCM',  'boomi','Process','Event',    19,2,2,1,'basic',          2,'SAP Ariba',           'Partial'),
  art('Payment_Status_Update',           'FIN',  'boomi','Process','API',      10,2,1,0,'basic',          1,'SAP S/4HANA',         'Auto'),
  art('Employee_New_Hire_SF',            'HR',   'boomi','Process','Event',    25,2,3,1,'try_catch',      3,'SAP SuccessFactors',  'Partial'),
  art('Inventory_Level_Sync',            'SCM',  'boomi','Process','Schedule', 20,3,2,0,'basic',          2,'SAP S/4HANA',         'Auto'),
  art('Delivery_Tracking_Update',        'SCM',  'boomi','Process','API',      15,2,2,0,'basic',          1,'HTTP/REST',           'Auto'),
  art('EDI_856_ASN_Outbound',            'EXT',  'boomi','Process','Event',    35,3,5,2,'multi_try_catch',5,'AS2',                 'Manual'),
  art('PO_Change_Notification',          'SCM',  'boomi','Process','Event',    18,2,2,1,'basic',          2,'SAP Ariba',           'Partial'),
  art('Cost_Center_Hierarchy_Sync',      'FIN',  'boomi','Process','Schedule',  9,1,1,0,'basic',          1,'SAP S/4HANA',         'Auto'),
  art('HR_Org_Structure_Publish',        'HR',   'boomi','Process','Schedule', 28,2,4,2,'try_catch',      4,'SAP SuccessFactors',  'Partial'),
  art('Customer_Credit_Check',           'CRM',  'boomi','Process','API',      13,2,2,0,'basic',          1,'Salesforce',          'Auto'),
  art('Supplier_Invoice_Inbound',        'FIN',  'boomi','Process','Listener', 33,3,4,1,'try_catch',      4,'SFTP',                'Partial'),
  art('Product_Catalog_Sync',            'SCM',  'boomi','Process','Schedule', 11,2,1,0,'basic',          1,'HTTP/REST',           'Auto'),
  art('Sales_Quota_Upload',              'CRM',  'boomi','Process','API',       8,1,1,0,'none',           1,'Salesforce',          'Auto'),
  art('Payslip_Distribution',            'HR',   'boomi','Process','Schedule', 24,2,3,1,'basic',          3,'SFTP',                'Partial'),
  art('Bank_Statement_Recon',            'FIN',  'boomi','Process','Listener', 40,3,5,3,'multi_try_catch',6,'SFTP',                'Manual'),
  art('Service_Order_Create',            'SCM',  'boomi','Process','API',      21,3,3,1,'try_catch',      3,'SAP S/4HANA',         'Partial'),
  art('Contract_Management_Sync',        'FIN',  'boomi','Process','Schedule', 17,2,2,0,'basic',          2,'SAP Ariba',           'Auto'),
  art('Warehouse_Transfer_Order',        'SCM',  'boomi','Process','Event',    26,3,3,1,'try_catch',      3,'SAP S/4HANA',         'Partial'),
  art('Customer_Returns_RMA',            'CRM',  'boomi','Process','API',      19,2,2,1,'basic',          2,'Salesforce',          'Partial'),
  art('GL_Journal_Posting',              'FIN',  'boomi','Process','Schedule', 14,2,2,0,'basic',          2,'SAP S/4HANA',         'Auto'),
  art('Production_Order_Status',         'SCM',  'boomi','Process','Event',    22,2,2,1,'basic',          2,'SAP S/4HANA',         'Partial'),
  art('EDI_810_Invoice_Outbound',        'EXT',  'boomi','Process','Event',    37,3,5,3,'multi_try_catch',5,'AS2',                 'Manual'),
];

// ── Demo Project 2: ACME Logistics (SAP PI/PO) — 20 artifacts ──────────────
const pipoArtifacts = [
  art('Customer_Master_Distribution',    'CRM',  'pipo','IntegrationScenario','Event',    14,2,1,0,'basic',     1,'IDoc',      'Auto'),
  art('Purchase_Order_Inbound_EDI',      'SCM',  'pipo','IntegrationScenario','Listener', 28,3,5,2,'try_catch', 4,'AS2',       'Manual'),
  art('Invoice_Outbound_EDIFACT',        'FIN',  'pipo','IntegrationScenario','Event',    32,3,5,2,'try_catch', 4,'AS2',       'Manual'),
  art('Delivery_Notification_RFC',       'SCM',  'pipo','IntegrationScenario','API',      12,2,1,0,'basic',     1,'RFC',       'Auto'),
  art('HR_Employee_Sync_IDoc',           'HR',   'pipo','IntegrationScenario','Event',    18,2,2,0,'basic',     2,'IDoc',      'Auto'),
  art('Stock_Movement_Batch',            'SCM',  'pipo','IntegrationScenario','Schedule', 20,2,2,1,'basic',     2,'JDBC',      'Partial'),
  art('Sales_Order_Confirmation',        'CRM',  'pipo','IntegrationScenario','API',      15,2,2,0,'basic',     1,'HTTP/REST', 'Auto'),
  art('Payment_Status_Update_RFC',       'FIN',  'pipo','IntegrationScenario','API',      10,2,1,0,'basic',     1,'RFC',       'Auto'),
  art('Vendor_Master_Sync_PI',           'FIN',  'pipo','IntegrationScenario','Event',    16,2,2,0,'basic',     2,'IDoc',      'Auto'),
  art('Material_Master_Dist_Multi',      'SCM',  'pipo','IntegrationScenario','Event',    24,3,3,1,'try_catch', 3,'IDoc',      'Partial'),
  art('GR_GI_Notification',              'SCM',  'pipo','IntegrationScenario','Event',    14,2,1,0,'basic',     1,'IDoc',      'Auto'),
  art('Batch_Status_Monitoring',         'SCM',  'pipo','IntegrationScenario','Schedule', 11,2,1,0,'basic',     1,'HTTP/REST', 'Auto'),
  art('Finance_GL_Posting_IDoc',         'FIN',  'pipo','IntegrationScenario','Event',    18,2,2,0,'basic',     2,'IDoc',      'Auto'),
  art('Logistics_Invoice_Verify',        'FIN',  'pipo','IntegrationScenario','Event',    22,2,2,1,'basic',     2,'IDoc',      'Partial'),
  art('Customer_Order_Status_REST',      'CRM',  'pipo','IntegrationScenario','API',      13,2,1,0,'basic',     1,'HTTP/REST', 'Auto'),
  art('EDI_DESADV_Outbound',             'EXT',  'pipo','IntegrationScenario','Event',    30,3,4,2,'try_catch', 4,'AS2',       'Manual'),
  art('Tax_Reporting_Interface',         'FIN',  'pipo','IntegrationScenario','Schedule', 16,2,2,1,'basic',     2,'SFTP',      'Partial'),
  art('Production_MRP_Sync',             'SCM',  'pipo','IntegrationScenario','Schedule', 21,3,3,1,'basic',     2,'IDoc',      'Partial'),
  art('Quality_Notification_Sync',       'SCM',  'pipo','IntegrationScenario','Event',    12,2,1,0,'basic',     1,'IDoc',      'Auto'),
  art('Intercompany_Billing',            'FIN',  'pipo','IntegrationScenario','Event',    26,3,3,2,'try_catch', 3,'IDoc',      'Partial'),
];

// ── Demo Project 3: TechCorp Digital (MuleSoft) — 18 artifacts ─────────────
const mulesoftArtifacts = [
  art('Customer_360_API',                'CRM',  'mulesoft','Flow','API',       22,3,3,2,'try_catch',      3,'HTTP',       'Partial'),
  art('Loan_Application_Flow',           'FIN',  'mulesoft','Flow','API',       35,4,4,3,'multi_try_catch',5,'HTTP',       'Manual'),
  art('Account_Statement_Batch',         'FIN',  'mulesoft','Batch','Schedule', 28,3,4,2,'try_catch',      4,'JDBC',       'Partial'),
  art('Payment_Notification_Event',      'FIN',  'mulesoft','Flow','Event',     18,2,2,1,'basic',          2,'Kafka',      'Partial'),
  art('Credit_Check_API',                'FIN',  'mulesoft','Flow','API',       12,2,1,0,'basic',          1,'HTTP',       'Auto'),
  art('Document_Archive_S3',             'INT',  'mulesoft','Flow','API',       10,2,1,1,'basic',          1,'S3',         'Auto'),
  art('Customer_Onboarding_Flow',        'CRM',  'mulesoft','Flow','API',       30,3,3,2,'try_catch',      3,'Salesforce', 'Partial'),
  art('Trade_Settlement_Batch',          'FIN',  'mulesoft','Batch','Schedule', 42,4,5,3,'multi_try_catch',6,'JDBC',       'Manual'),
  art('Fraud_Detection_Event',           'FIN',  'mulesoft','Flow','Event',     25,3,2,2,'try_catch',      2,'Kafka',      'Partial'),
  art('KYC_Document_Check',              'CRM',  'mulesoft','Flow','API',       19,2,2,1,'basic',          2,'HTTP',       'Partial'),
  art('Interest_Calc_Scheduler',         'FIN',  'mulesoft','Flow','Schedule',  14,2,1,1,'basic',          1,'JDBC',       'Auto'),
  art('Regulatory_Report_File',          'FIN',  'mulesoft','Flow','Schedule',  22,2,3,1,'basic',          3,'SFTP',       'Partial'),
  art('Branch_Data_Sync',                'INT',  'mulesoft','Flow','Schedule',  15,2,2,0,'basic',          1,'HTTP',       'Auto'),
  art('Card_Transaction_Listener',       'FIN',  'mulesoft','Flow','Listener',  20,2,2,1,'try_catch',      2,'JMS',        'Partial'),
  art('Customer_Profile_Update',         'CRM',  'mulesoft','Flow','API',       11,2,1,0,'basic',          1,'Salesforce', 'Auto'),
  art('ATM_Network_Integration',         'FIN',  'mulesoft','Flow','Event',     32,3,3,2,'try_catch',      3,'JMS',        'Partial'),
  art('Mortgage_Pipeline_Sync',          'FIN',  'mulesoft','Flow','Schedule',  26,3,3,2,'try_catch',      3,'JDBC',       'Partial'),
  art('Insurance_Claim_Flow',            'FIN',  'mulesoft','Flow','API',       38,4,4,3,'multi_try_catch',5,'HTTP',       'Manual'),
];

// ── Demo Project 4: RetailCo Operations (TIBCO BW) — 22 artifacts ──────────
const retailCoArtifacts = [
  art('OrderFulfillment_Orchestration',  'SCM',  'tibco','ProcessDef','API',      28,3,3,2,'try_catch',      3,'HTTP',  'Partial'),
  art('InventoryLevel_Sync_Batch',       'SCM',  'tibco','ProcessDef','Schedule', 22,2,2,0,'basic',          2,'JDBC',  'Auto'),
  art('CustomerLoyalty_Event_Process',   'CRM',  'tibco','ProcessDef','Event',    18,2,2,1,'basic',          2,'JMS',   'Partial'),
  art('POS_Transaction_Inbound',         'INT',  'tibco','ProcessDef','Listener', 24,3,3,1,'try_catch',      3,'SFTP',  'Partial'),
  art('Supplier_EDI_Processing',         'EXT',  'tibco','ProcessDef','Listener', 40,3,5,3,'multi_try_catch',5,'AS2',   'Manual'),
  art('Store_Replenishment_API',         'SCM',  'tibco','ProcessDef','API',      16,2,2,0,'basic',          1,'HTTP',  'Auto'),
  art('Price_Update_Broadcast',          'SCM',  'tibco','ProcessDef','Event',    14,2,1,0,'basic',          1,'JMS',   'Auto'),
  art('Customer_Returns_Process',        'CRM',  'tibco','ProcessDef','API',      20,2,2,1,'basic',          2,'HTTP',  'Partial'),
  art('Finance_GL_Interface',            'FIN',  'tibco','ProcessDef','Schedule', 25,3,3,1,'try_catch',      3,'JDBC',  'Partial'),
  art('Loyalty_Points_Calc',             'CRM',  'tibco','ProcessDef','Event',    19,2,2,1,'basic',          2,'JMS',   'Partial'),
  art('Warehouse_Pick_Ticket',           'SCM',  'tibco','ProcessDef','Event',    17,2,2,0,'basic',          2,'JMS',   'Auto'),
  art('Supplier_Invoice_Match',          'FIN',  'tibco','ProcessDef','Event',    30,3,3,2,'try_catch',      3,'SFTP',  'Partial'),
  art('Campaign_Trigger_Event',          'CRM',  'tibco','ProcessDef','Event',    12,2,1,0,'basic',          1,'JMS',   'Auto'),
  art('Stock_Count_Reconcile',           'SCM',  'tibco','ProcessDef','Schedule', 21,2,2,1,'basic',          2,'JDBC',  'Partial'),
  art('Order_Status_Notification',       'SCM',  'tibco','ProcessDef','Event',    13,2,1,0,'basic',          1,'SMTP',  'Auto'),
  art('EDI_855_PO_Acknowledgement',      'EXT',  'tibco','ProcessDef','Event',    33,3,4,2,'try_catch',      4,'AS2',   'Manual'),
  art('HR_Payroll_Interface',            'HR',   'tibco','ProcessDef','Schedule', 28,2,3,1,'basic',          3,'SFTP',  'Partial'),
  art('Cash_Register_Sync',              'INT',  'tibco','ProcessDef','Schedule', 15,2,1,0,'basic',          1,'JDBC',  'Auto'),
  art('Product_Taxonomy_Update',         'SCM',  'tibco','ProcessDef','Schedule', 11,2,1,0,'basic',          1,'HTTP',  'Auto'),
  art('Return_Auth_Processing',          'CRM',  'tibco','ProcessDef','API',      22,2,2,1,'try_catch',      2,'HTTP',  'Partial'),
  art('Vendor_Payment_Batch',            'FIN',  'tibco','ProcessDef','Schedule', 35,3,4,2,'try_catch',      4,'SFTP',  'Partial'),
  art('Cross_Channel_Order_Merge',       'SCM',  'tibco','ProcessDef','Event',    38,4,4,3,'multi_try_catch',5,'JMS',   'Manual'),
];

// ════════════════════════════════════════════════════════════════════════════
// ── Project name registry (used for idempotent delete on normal seed)
// ════════════════════════════════════════════════════════════════════════════
const SLB_PROJECT_NAMES = [
  'SLB Field Operations Integration',
  'SLB Enterprise Services Integration'
];

const ALL_PROJECT_NAMES = [
  ...SLB_PROJECT_NAMES,
  'GlobalTech Manufacturing',
  'ACME Logistics',
  'TechCorp Digital',
  'RetailCo Operations'
];

// ════════════════════════════════════════════════════════════════════════════
// ── Seed runner
// ════════════════════════════════════════════════════════════════════════════
async function insertArtifacts(client, sourceId, projectId, artifacts, prefix) {
  for (const a of artifacts) {
    await client.query(
      `INSERT INTO artifacts (source_id,project_id,process_id,name,domain,platform,artifact_type,trigger_type,
        shapes_count,connectors_count,maps_count,has_scripting,scripting_detail,error_handling,
        dependencies_count,primary_connector,complexity_score,complexity_level,tshirt_size,effort_days,readiness,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'discovered')`,
      [sourceId,projectId,`${prefix}-${a.name}`,a.name,a.domain,a.platform,a.artifact_type,a.trigger_type,
       a.shapes_count,a.connectors_count,a.maps_count,a.has_scripting,a.scripting_detail,a.error_handling,
       a.dependencies_count,a.primary_connector,a.complexity_score,a.complexity_level,a.tshirt_size,a.effort_days,a.readiness]
    );
  }
}

async function runSeed(force = false) {
  await initDb();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (force) {
      // Wipe everything — used for demo reset
      await client.query('DELETE FROM projects');
    } else {
      // Idempotent — only remove known seed projects
      await client.query(`DELETE FROM projects WHERE name = ANY($1)`, [ALL_PROJECT_NAMES]);
    }

    // ── SLB Project 1: Field Operations (Boomi) ──────────────────────────────
    const p1 = await client.query(
      `INSERT INTO projects (name, customer, consultant, platform, description, status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING id`,
      ['SLB Field Operations Integration', 'SLB (Schlumberger)', 'Sriman Parisuchitha', 'boomi',
       'Boomi AtomSphere to SAP Integration Suite migration — 30 integration processes spanning Drilling, Well Data, Field Services, Asset Management, HSE, and Supply Chain. SLB is consolidating on SAP BTP as part of their global digital transformation initiative to modernize integration infrastructure across 120+ countries.']
    );
    const sc1 = await client.query(
      `INSERT INTO source_connections (project_id,type,name,platform,config,status,artifacts_found,last_synced_at)
       VALUES ($1,'api','SLB Boomi AtomSphere — PROD','boomi','{"accountId":"slb-prod-us","environment":"Production","authentication":"Basic Auth","region":"US-East"}','synced',30,NOW()) RETURNING id`,
      [p1.rows[0].id]
    );
    await insertArtifacts(client, sc1.rows[0].id, p1.rows[0].id, slbBoomiArtifacts, 'boomi-slb');

    // ── SLB Project 2: Enterprise Services (TIBCO) ───────────────────────────
    const p2 = await client.query(
      `INSERT INTO projects (name, customer, consultant, platform, description, status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING id`,
      ['SLB Enterprise Services Integration', 'SLB (Schlumberger)', 'Sriman Parisuchitha', 'tibco',
       'TIBCO BusinessWorks 5.x to SAP Integration Suite migration — 22 enterprise integration processes across Finance, HR, Procurement, Logistics, and Reporting. End-of-life TIBCO BW license and SAP S/4HANA adoption driving migration to SAP BTP Integration Suite.']
    );
    const sc2 = await client.query(
      `INSERT INTO source_connections (project_id,type,name,platform,config,status,artifacts_found,last_synced_at)
       VALUES ($1,'zip','SLB TIBCO BW 5.x Project Export','tibco','{"filename":"slb_tibco_bw_project.zip","size":6200000,"bwVersion":"5.14","designer":"TIBCO Designer"}','synced',22,NOW()) RETURNING id`,
      [p2.rows[0].id]
    );
    await insertArtifacts(client, sc2.rows[0].id, p2.rows[0].id, slbTibcoArtifacts, 'tibco-slb');

    // ── Demo Project 1: GlobalTech Manufacturing (Boomi) ─────────────────────
    const p3 = await client.query(
      `INSERT INTO projects (name, customer, consultant, platform, description, status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING id`,
      ['GlobalTech Manufacturing', 'GlobalTech Industries Inc.', 'Sriman Parisuchitha', 'boomi',
       'Boomi AtomSphere to SAP Integration Suite migration — 30 integration processes across CRM, HR, Finance, and Supply Chain domains. Phase 1 of 3-year digital transformation program.']
    );
    const sc3 = await client.query(
      `INSERT INTO source_connections (project_id,type,name,platform,config,status,artifacts_found,last_synced_at)
       VALUES ($1,'api','Boomi AtomSphere — PROD','boomi','{"accountId":"globaltech-prod","environment":"Production","authentication":"Basic Auth"}','synced',30,NOW()) RETURNING id`,
      [p3.rows[0].id]
    );
    await insertArtifacts(client, sc3.rows[0].id, p3.rows[0].id, globalTechArtifacts, 'boomi-gt');

    // ── Demo Project 2: ACME Logistics (SAP PI/PO) ────────────────────────────
    const p4 = await client.query(
      `INSERT INTO projects (name, customer, consultant, platform, description, status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING id`,
      ['ACME Logistics', 'ACME Logistics GmbH', 'Priya Sharma', 'pipo',
       'SAP PI/PO 7.5 to SAP Integration Suite migration — 20 integration scenarios for logistics and supply chain. Customer running SAP ERP ECC 6.0 with plans to migrate to S/4HANA post-integration modernization.']
    );
    const sc4 = await client.query(
      `INSERT INTO source_connections (project_id,type,name,platform,config,status,artifacts_found,last_synced_at)
       VALUES ($1,'zip','SAP PI 7.5 Export — XI Repository','pipo','{"filename":"pi75_export.zip","size":4200000}','synced',20,NOW()) RETURNING id`,
      [p4.rows[0].id]
    );
    await insertArtifacts(client, sc4.rows[0].id, p4.rows[0].id, pipoArtifacts, 'pipo-acme');

    // ── Demo Project 3: TechCorp Digital (MuleSoft) ───────────────────────────
    const p5 = await client.query(
      `INSERT INTO projects (name, customer, consultant, platform, description, status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING id`,
      ['TechCorp Digital', 'TechCorp Financial Services Ltd.', 'Raj Patel', 'mulesoft',
       'MuleSoft Anypoint Platform to SAP Integration Suite migration — 18 API-led integration flows for a fintech company. Customer consolidating on SAP BTP after MuleSoft contract renewal decision.']
    );
    const sc5 = await client.query(
      `INSERT INTO source_connections (project_id,type,name,platform,config,status,artifacts_found,last_synced_at)
       VALUES ($1,'zip','MuleSoft Anypoint — mule-config export','mulesoft','{"filename":"mulesoft_config.xml","size":3100000}','synced',18,NOW()) RETURNING id`,
      [p5.rows[0].id]
    );
    await insertArtifacts(client, sc5.rows[0].id, p5.rows[0].id, mulesoftArtifacts, 'mule-tc');

    // ── Demo Project 4: RetailCo Operations (TIBCO BW) ────────────────────────
    const p6 = await client.query(
      `INSERT INTO projects (name, customer, consultant, platform, description, status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING id`,
      ['RetailCo Operations', 'RetailCo International PLC', 'Anika Gupta', 'tibco',
       'TIBCO BusinessWorks 5.x to SAP Integration Suite migration — 22 integration processes for a multinational retail company. End-of-life TIBCO BW license driving migration timeline.']
    );
    const sc6 = await client.query(
      `INSERT INTO source_connections (project_id,type,name,platform,config,status,artifacts_found,last_synced_at)
       VALUES ($1,'zip','TIBCO BW 5.x Project Export','tibco','{"filename":"tibco_bw_project.zip","size":5800000}','synced',22,NOW()) RETURNING id`,
      [p6.rows[0].id]
    );
    await insertArtifacts(client, sc6.rows[0].id, p6.rows[0].id, retailCoArtifacts, 'tibco-rc');

    await client.query('COMMIT');

    const slbTotal    = slbBoomiArtifacts.length + slbTibcoArtifacts.length;
    const demoTotal   = globalTechArtifacts.length + pipoArtifacts.length + mulesoftArtifacts.length + retailCoArtifacts.length;
    const grandTotal  = slbTotal + demoTotal;
    console.log(`Seed complete: 6 projects, ${grandTotal} artifacts.`);
    console.log(`  SLB  — Field Operations (Boomi):           ${slbBoomiArtifacts.length} artifacts`);
    console.log(`  SLB  — Enterprise Services (TIBCO):        ${slbTibcoArtifacts.length} artifacts`);
    console.log(`  Demo — GlobalTech Manufacturing (Boomi):   ${globalTechArtifacts.length} artifacts`);
    console.log(`  Demo — ACME Logistics (SAP PI/PO):         ${pipoArtifacts.length} artifacts`);
    console.log(`  Demo — TechCorp Digital (MuleSoft):        ${mulesoftArtifacts.length} artifacts`);
    console.log(`  Demo — RetailCo Operations (TIBCO):        ${retailCoArtifacts.length} artifacts`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runSeed, SLB_PROJECT_NAMES, ALL_PROJECT_NAMES };

if (require.main === module) {
  const force = process.argv.includes('--force');
  runSeed(force)
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}
