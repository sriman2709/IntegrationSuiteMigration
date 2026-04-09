/**
 * PDF Assessment Report Generator — Sprint 3
 * Generates a professional Sierra Digital branded migration assessment report
 * using PDFKit (pure Node.js, no headless browser, lightweight on Azure B1).
 */

const PDFDocument = require('pdfkit');

// ── Brand colours
const C = {
  navyDark:   '#0A1929',
  navyMid:    '#1C2B3A',
  accent:     '#0066CC',
  accentLight:'#E8F4FF',
  success:    '#28A745',
  warning:    '#F59E0B',
  danger:     '#DC3545',
  textPrimary:'#1A1A2E',
  textSecondary:'#6B7280',
  borderLight:'#E5E7EB',
  white:      '#FFFFFF',
  slbOrange:  '#FF6600',   // SLB brand orange for accents
  pageGutter: 50
};

// ── Helpers
function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return [r,g,b];
}
function rgb(hex)   { return hexToRgb(hex); }
function fillColor(doc, hex) { return doc.fillColor(rgb(hex)); }
function strokeColor(doc, hex) { return doc.strokeColor(rgb(hex)); }

// ── Page dimensions
const W = 595.28;  // A4 width pt
const H = 841.89;  // A4 height pt
const L = C.pageGutter;      // left margin
const R = W - C.pageGutter;  // right edge
const TW = R - L;             // text width

// ── Entry point ──────────────────────────────────────────────────────────────

async function generatePDFReport(project, artifacts, stats) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        info: {
          Title: `SAP IS Migration Assessment — ${project.name}`,
          Author: 'Sierra Digital Consulting',
          Subject: 'Integration Suite Migration Assessment Report',
          Keywords: 'SAP Integration Suite, Migration, Assessment, Sierra Digital'
        }
      });

      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ── Pages
      buildCoverPage(doc, project, stats);
      doc.addPage();
      buildExecutiveSummary(doc, project, artifacts, stats);
      doc.addPage();
      buildComplexityBreakdown(doc, artifacts, stats);
      doc.addPage();
      buildMigrationTimeline(doc, artifacts, stats, project);
      doc.addPage();
      buildArtifactInventory(doc, artifacts, project);
      doc.addPage();
      buildRiskRegister(doc, artifacts, project);
      doc.addPage();
      buildRecommendations(doc, project, stats);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ── PAGE 1: Cover ─────────────────────────────────────────────────────────────

function buildCoverPage(doc, project, stats) {
  // Full-bleed dark navy header band
  fillColor(doc, C.navyDark).rect(0, 0, W, 320).fill();

  // Sierra Digital logo area — stylised text
  fillColor(doc, C.accent).fontSize(11).font('Helvetica-Bold')
    .text('SIERRA DIGITAL', L, 48, { characterSpacing: 3 });
  fillColor(doc, C.textSecondary).fontSize(9).font('Helvetica')
    .text('SAP Integration Suite Practice', L, 64);

  // Horizontal rule
  strokeColor(doc, C.accent).lineWidth(2)
    .moveTo(L, 80).lineTo(R, 80).stroke();

  // Main title
  fillColor(doc, C.white).fontSize(26).font('Helvetica-Bold')
    .text('SAP Integration Suite', L, 110, { width: TW })
    .text('Migration Assessment', L, 143, { width: TW });

  fillColor(doc, C.accent).fontSize(14).font('Helvetica')
    .text('Comprehensive Platform Migration Analysis & Roadmap', L, 186, { width: TW });

  // Client info band
  fillColor(doc, C.navyMid).rect(0, 228, W, 92).fill();

  fillColor(doc, C.textSecondary).fontSize(9).font('Helvetica')
    .text('PREPARED FOR', L, 244, { characterSpacing: 1 });
  fillColor(doc, C.white).fontSize(20).font('Helvetica-Bold')
    .text(project.customer || project.name, L, 258, { width: TW });
  fillColor(doc, C.textSecondary).fontSize(10).font('Helvetica')
    .text(project.name, L, 286, { width: TW });

  // White content area
  fillColor(doc, C.white).rect(0, 320, W, H - 320).fill();

  // Project meta cards — 3 across
  const cardW = (TW - 24) / 3;
  const cardTop = 348;
  const cardData = [
    { label: 'Source Platform', value: (project.platform || 'Unknown').toUpperCase() },
    { label: 'Total Processes',  value: String(artifacts.length || stats.total || 0) },
    { label: 'Migration Effort',  value: `${stats.total_effort_days || 0} Days` }
  ];
  cardData.forEach((card, i) => {
    const cx = L + i * (cardW + 12);
    fillColor(doc, C.accentLight).roundedRect(cx, cardTop, cardW, 80, 6).fill();
    strokeColor(doc, C.accent).lineWidth(1).roundedRect(cx, cardTop, cardW, 80, 6).stroke();
    fillColor(doc, C.textSecondary).fontSize(8).font('Helvetica')
      .text(card.label.toUpperCase(), cx + 12, cardTop + 14, { width: cardW - 24, align: 'center', characterSpacing: 0.5 });
    fillColor(doc, C.accent).fontSize(20).font('Helvetica-Bold')
      .text(card.value, cx + 12, cardTop + 32, { width: cardW - 24, align: 'center' });
  });

  // Readiness breakdown bar
  const autoCount    = artifacts.filter(a => a.readiness === 'Auto').length;
  const partialCount = artifacts.filter(a => a.readiness === 'Partial').length;
  const manualCount  = artifacts.filter(a => a.readiness === 'Manual').length;
  const total        = artifacts.length || 1;

  const barTop = 460;
  fillColor(doc, C.textPrimary).fontSize(10).font('Helvetica-Bold')
    .text('Migration Readiness Overview', L, barTop, { width: TW });

  const barY = barTop + 22;
  const barH = 24;
  let xOff = L;
  const segments = [
    { count: autoCount,    color: C.success, label: 'Auto-Convert' },
    { count: partialCount, color: C.warning, label: 'Semi-Auto' },
    { count: manualCount,  color: C.danger,  label: 'Manual' }
  ];
  segments.forEach(seg => {
    const segW = Math.max((seg.count / total) * TW, seg.count > 0 ? 4 : 0);
    fillColor(doc, seg.color).rect(xOff, barY, segW, barH).fill();
    xOff += segW;
  });
  // Legend
  let lx = L;
  segments.forEach(seg => {
    fillColor(doc, seg.color).rect(lx, barY + barH + 8, 10, 10).fill();
    fillColor(doc, C.textPrimary).fontSize(9).font('Helvetica')
      .text(`${seg.label}: ${seg.count}`, lx + 14, barY + barH + 8, { width: 120 });
    lx += 140;
  });

  // Complexity doughnut (text-based)
  const simpleCount  = artifacts.filter(a => a.complexity_level === 'Simple').length;
  const mediumCount  = artifacts.filter(a => a.complexity_level === 'Medium').length;
  const complexCount = artifacts.filter(a => a.complexity_level === 'Complex').length;

  const tableTop = 545;
  fillColor(doc, C.textPrimary).fontSize(10).font('Helvetica-Bold')
    .text('Complexity Distribution', L, tableTop, { width: TW });

  const compData = [
    { label: 'Simple (Auto-Convert)',  count: simpleCount,  color: C.success, effort: artifacts.filter(a=>a.complexity_level==='Simple').reduce((s,a)=>s+(a.effort_days||0),0) },
    { label: 'Medium (Semi-Auto)',     count: mediumCount,  color: C.warning, effort: artifacts.filter(a=>a.complexity_level==='Medium').reduce((s,a)=>s+(a.effort_days||0),0) },
    { label: 'Complex (Manual Work)',  count: complexCount, color: C.danger,  effort: artifacts.filter(a=>a.complexity_level==='Complex').reduce((s,a)=>s+(a.effort_days||0),0) }
  ];

  compData.forEach((row, i) => {
    const ry = tableTop + 22 + i * 34;
    fillColor(doc, i % 2 === 0 ? C.accentLight : C.white).rect(L, ry, TW, 30).fill();
    fillColor(doc, row.color).rect(L, ry, 4, 30).fill();
    fillColor(doc, C.textPrimary).fontSize(10).font('Helvetica')
      .text(row.label, L + 14, ry + 9, { width: 200 });
    fillColor(doc, C.textPrimary).fontSize(10).font('Helvetica-Bold')
      .text(String(row.count), L + 220, ry + 9, { width: 60, align: 'center' });
    fillColor(doc, C.textSecondary).fontSize(10).font('Helvetica')
      .text(`${row.effort} days effort`, L + 300, ry + 9, { width: 180 });
    const pct = total > 0 ? Math.round((row.count / total) * 100) : 0;
    fillColor(doc, C.textSecondary).fontSize(10).font('Helvetica')
      .text(`${pct}%`, L + 450, ry + 9, { width: 50, align: 'right' });
  });

  // Footer
  buildFooter(doc, project, 1);
}

// ── PAGE 2: Executive Summary ─────────────────────────────────────────────────

function buildExecutiveSummary(doc, project, artifacts, stats) {
  buildPageHeader(doc, 'Executive Summary', project);

  let y = 130;
  const platform = (project.platform || 'source').toUpperCase();
  const customer = project.customer || project.name;

  // Intro paragraph
  fillColor(doc, C.textPrimary).fontSize(10).font('Helvetica')
    .text(
      `Sierra Digital has completed a comprehensive technical assessment of ${customer}'s ${platform} integration landscape as part of the planned migration to SAP Integration Suite (SAP BTP). This report presents our findings, complexity analysis, risk assessment, and recommended migration roadmap.`,
      L, y, { width: TW, lineGap: 3 }
    );
  y += 58;

  // Key findings boxes — 2 × 2 grid
  fillColor(doc, C.textPrimary).fontSize(11).font('Helvetica-Bold').text('Key Findings', L, y);
  y += 20;

  const autoCount    = artifacts.filter(a => a.readiness === 'Auto').length;
  const manualCount  = artifacts.filter(a => a.readiness === 'Manual').length;
  const totalEffort  = stats.total_effort_days || artifacts.reduce((s,a)=>s+(a.effort_days||0),0);
  const complexCount = artifacts.filter(a => a.complexity_level === 'Complex').length;
  const months       = Math.ceil(totalEffort / 20);

  const findings = [
    { icon: '✓', color: C.success, title: `${autoCount} Processes — Direct Auto-Conversion`, body: `${Math.round((autoCount/artifacts.length)*100)}% of integration processes can be automatically converted to SAP IS iFlows with minimal manual effort, significantly reducing project risk and timeline.` },
    { icon: '!', color: C.warning, title: `${complexCount} Complex Processes Require Review`, body: `${complexCount} processes contain custom scripting, complex EDI mapping, or multi-system orchestration patterns requiring architectural review and specialist effort.` },
    { icon: '◷', color: C.accent,  title: `Estimated ${totalEffort} Person-Days Total Effort`, body: `Full migration effort across ${artifacts.length} processes estimated at ${totalEffort} person-days (${months} months), covering conversion, testing, and go-live activities.` },
    { icon: '★', color: C.slbOrange, title: 'SAP BTP Native Adapters Available', body: `All identified connector types — ${getTopConnectors(artifacts, 3)} — have native SAP IS adapters, eliminating third-party middleware licensing costs post-migration.` }
  ];

  const fW = (TW - 12) / 2;
  findings.forEach((f, i) => {
    const fx = L + (i % 2) * (fW + 12);
    const fy = y + Math.floor(i / 2) * 100;
    fillColor(doc, C.accentLight).roundedRect(fx, fy, fW, 88, 5).fill();
    fillColor(doc, f.color).rect(fx, fy, 3, 88).fill();
    fillColor(doc, f.color).fontSize(14).font('Helvetica-Bold').text(f.icon, fx + 10, fy + 10);
    fillColor(doc, C.textPrimary).fontSize(9).font('Helvetica-Bold')
      .text(f.title, fx + 28, fy + 11, { width: fW - 36 });
    fillColor(doc, C.textSecondary).fontSize(8.5).font('Helvetica')
      .text(f.body, fx + 10, fy + 30, { width: fW - 20, lineGap: 2 });
  });
  y += 212;

  // Migration approach summary
  fillColor(doc, C.textPrimary).fontSize(11).font('Helvetica-Bold').text('Sierra Digital Migration Approach', L, y);
  y += 18;

  const approachSteps = [
    { num:'1', title:'Assessment & Planning',    weeks:'Weeks 1–2',  desc:'Validate mock assessment findings with live platform export, finalise artifact inventory, and establish SAP BTP tenant.' },
    { num:'2', title:'Auto-Conversion Sprint',   weeks:'Weeks 3–5',  desc:`Auto-convert the ${autoCount} Simple/Auto processes using SAP Migration Tool. Configure adapters with client-specific connection parameters.` },
    { num:'3', title:'Semi-Auto Conversion',     weeks:'Weeks 6–9',  desc:'Complete message mapping, scripting migration, and Groovy re-implementation for Medium complexity processes. Unit test each iFlow.' },
    { num:'4', title:'Complex Process Migration',weeks:'Weeks 10–14', desc:`Architect ${complexCount} complex processes including EDI, multi-system orchestration, and custom scripting. Performance and integration testing.` },
    { num:'5', title:'UAT & Go-Live',            weeks:'Weeks 15–16', desc:'User acceptance testing with client team. Parallel run if required. Cutover planning and go-live execution.' }
  ];

  approachSteps.forEach((step, i) => {
    const sy = y + i * 36;
    fillColor(doc, C.accent).circle(L + 10, sy + 10, 9).fill();
    fillColor(doc, C.white).fontSize(8).font('Helvetica-Bold')
      .text(step.num, L + 6, sy + 5, { width: 8 });
    fillColor(doc, C.textPrimary).fontSize(9).font('Helvetica-Bold')
      .text(`${step.title}  `, L + 26, sy + 2, { continued: true })
      .fillColor(rgb(C.textSecondary)).font('Helvetica').fontSize(8)
      .text(step.weeks);
    fillColor(doc, C.textSecondary).fontSize(8.5).font('Helvetica')
      .text(step.desc, L + 26, sy + 14, { width: TW - 28, lineGap: 1 });
    if (i < approachSteps.length - 1) {
      strokeColor(doc, C.borderLight).lineWidth(0.5)
        .moveTo(L + 10, sy + 19).lineTo(L + 10, sy + 36).stroke();
    }
  });

  buildFooter(doc, project, 2);
}

// ── PAGE 3: Complexity Breakdown ──────────────────────────────────────────────

function buildComplexityBreakdown(doc, artifacts, stats) {
  buildPageHeader(doc, 'Complexity & Effort Analysis', null);

  let y = 130;

  // Summary stat row
  const totalEffort  = artifacts.reduce((s,a)=>s+(a.effort_days||0),0);
  const avgScore     = artifacts.length ? Math.round(artifacts.reduce((s,a)=>s+(a.complexity_score||0),0)/artifacts.length) : 0;
  const domains      = [...new Set(artifacts.map(a=>a.domain).filter(Boolean))].length;

  const statCols = [
    { label:'Total Artifacts',    value: String(artifacts.length) },
    { label:'Total Effort Days',  value: String(totalEffort) },
    { label:'Avg Complexity Score',value: String(avgScore) + '/100' },
    { label:'Domains Covered',    value: String(domains) }
  ];
  const scW = (TW - 18) / 4;
  statCols.forEach((s, i) => {
    const sx = L + i * (scW + 6);
    fillColor(doc, C.navyMid).roundedRect(sx, y, scW, 56, 5).fill();
    fillColor(doc, C.accent).fontSize(20).font('Helvetica-Bold')
      .text(s.value, sx + 6, y + 10, { width: scW - 12, align: 'center' });
    fillColor(doc, C.textSecondary).fontSize(8).font('Helvetica')
      .text(s.label, sx + 6, y + 36, { width: scW - 12, align: 'center' });
  });
  y += 74;

  // Domain breakdown table
  fillColor(doc, C.textPrimary).fontSize(11).font('Helvetica-Bold').text('Breakdown by Domain', L, y);
  y += 18;

  const domainMap = {};
  artifacts.forEach(a => {
    const d = a.domain || 'Other';
    if (!domainMap[d]) domainMap[d] = { simple:0, medium:0, complex:0, effort:0, count:0 };
    domainMap[d][a.complexity_level?.toLowerCase() || 'medium']++;
    domainMap[d].effort += (a.effort_days || 0);
    domainMap[d].count++;
  });

  // Table header
  const th = y;
  fillColor(doc, C.navyMid).rect(L, th, TW, 22).fill();
  const cols = [
    { label:'Domain',   x:L+8,   w:120 },
    { label:'Count',    x:L+135, w:40,  align:'center' },
    { label:'Simple',   x:L+182, w:50,  align:'center' },
    { label:'Medium',   x:L+238, w:50,  align:'center' },
    { label:'Complex',  x:L+294, w:55,  align:'center' },
    { label:'Effort(d)',x:L+356, w:55,  align:'center' },
    { label:'Readiness',x:L+418, w:TW-418+L-8, w2:77 }
  ];
  cols.forEach(c => {
    fillColor(doc, C.white).fontSize(8).font('Helvetica-Bold')
      .text(c.label, c.x, th + 7, { width: c.w || c.w2 || 80, align: c.align || 'left' });
  });
  y += 22;

  Object.entries(domainMap).sort((a,b)=>b[1].count-a[1].count).forEach(([domain, d], i) => {
    const ry = y + i * 24;
    fillColor(doc, i % 2 === 0 ? C.white : C.accentLight).rect(L, ry, TW, 24).fill();

    const autoCount = d.simple;
    const readinessPct = d.count > 0 ? Math.round((autoCount / d.count) * 100) : 0;
    const readinessColor = readinessPct >= 60 ? C.success : readinessPct >= 30 ? C.warning : C.danger;

    fillColor(doc, C.textPrimary).fontSize(9).font('Helvetica-Bold').text(domain, L+8, ry+7, { width:120 });
    fillColor(doc, C.textPrimary).fontSize(9).font('Helvetica').text(String(d.count),    L+135, ry+7, { width:40,  align:'center' });
    fillColor(doc, C.success).fontSize(9).font('Helvetica').text(String(d.simple),       L+182, ry+7, { width:50,  align:'center' });
    fillColor(doc, C.warning).fontSize(9).font('Helvetica').text(String(d.medium),       L+238, ry+7, { width:50,  align:'center' });
    fillColor(doc, C.danger).fontSize(9).font('Helvetica').text(String(d.complex),       L+294, ry+7, { width:55,  align:'center' });
    fillColor(doc, C.textPrimary).fontSize(9).font('Helvetica').text(String(d.effort),   L+356, ry+7, { width:55,  align:'center' });
    fillColor(doc, readinessColor).fontSize(9).font('Helvetica-Bold')
      .text(`${readinessPct}% Auto`, L+418, ry+7, { width:77, align:'center' });
  });

  y += Object.keys(domainMap).length * 24 + 24;

  // Connector / adapter breakdown
  if (y < H - 200) {
    fillColor(doc, C.textPrimary).fontSize(11).font('Helvetica-Bold').text('Primary Connectors Identified', L, y);
    y += 18;

    const connMap = {};
    artifacts.forEach(a => {
      const c = a.primary_connector || 'HTTP/REST';
      connMap[c] = (connMap[c] || 0) + 1;
    });
    const connEntries = Object.entries(connMap).sort((a,b)=>b[1]-a[1]);
    const maxCount = connEntries[0]?.[1] || 1;
    const barAreaW = TW - 200;

    connEntries.forEach(([conn, count], i) => {
      const ry = y + i * 22;
      if (ry > H - 100) return;
      fillColor(doc, C.textPrimary).fontSize(9).font('Helvetica').text(conn, L, ry + 4, { width: 190 });
      const bw = Math.max((count / maxCount) * barAreaW, 4);
      fillColor(doc, C.accentLight).rect(L + 196, ry, barAreaW, 16).fill();
      fillColor(doc, C.accent).rect(L + 196, ry, bw, 16).fill();
      fillColor(doc, C.white).fontSize(8).font('Helvetica-Bold').text(String(count), L + 196 + bw - 18, ry + 4, { width:16, align:'right' });
    });
  }

  buildFooter(doc, null, 3);
}

// ── PAGE 4: Migration Timeline ────────────────────────────────────────────────

function buildMigrationTimeline(doc, artifacts, stats, project) {
  buildPageHeader(doc, 'Migration Roadmap & Timeline', project);

  let y = 130;
  const totalEffort = artifacts.reduce((s,a)=>s+(a.effort_days||0),0);
  const platform = (project?.platform || 'source').toUpperCase();

  // Timeline intro
  fillColor(doc, C.textSecondary).fontSize(9.5).font('Helvetica')
    .text(`The following phased migration roadmap is recommended for ${project?.customer || 'the client'}'s ${platform} to SAP Integration Suite migration, based on complexity analysis of ${artifacts.length} integration processes.`, L, y, { width: TW, lineGap: 2 });
  y += 42;

  // Phase blocks
  const autoArts    = artifacts.filter(a => a.readiness === 'Auto');
  const partialArts = artifacts.filter(a => a.readiness === 'Partial');
  const manualArts  = artifacts.filter(a => a.readiness === 'Manual');

  const phases = [
    {
      num: 'Phase 1', title: 'Foundation & Environment Setup', weeks: '2 weeks', color: C.accent,
      effort: 5,
      activities: ['SAP BTP tenant provisioning and IS subscription activation','Connection & credential configuration for all adapters','Import auto-converted iFlow packages from Sierra Digital migration tool','Smoke testing and connectivity validation in DEV landscape']
    },
    {
      num: 'Phase 2', title: `Auto-Conversion (${autoArts.length} processes)`, weeks: `${Math.ceil(autoArts.reduce((s,a)=>s+(a.effort_days||0),0)/5)} weeks`, color: C.success,
      effort: autoArts.reduce((s,a)=>s+(a.effort_days||0),0),
      activities: [`Deploy ${autoArts.length} auto-converted iFlow packages to DEV`,`Configure externalized parameters (parameters.prop) for each iFlow`,'Execute functional test cases from IS Migration Tool validation engine','Promote validated iFlows through TEST to PROD using SAP BTP transport management']
    },
    {
      num: 'Phase 3', title: `Semi-Auto Migration (${partialArts.length} processes)`, weeks: `${Math.ceil(partialArts.reduce((s,a)=>s+(a.effort_days||0),0)/5)} weeks`, color: C.warning,
      effort: partialArts.reduce((s,a)=>s+(a.effort_days||0),0),
      activities: [`Complete message mapping for ${partialArts.length} semi-auto processes in IS Integration Designer`,`Migrate Groovy script stubs with full business logic implementation`,'Configure SAP IS standard error handling and alerting','Integration testing with connected systems in TEST landscape']
    },
    {
      num: 'Phase 4', title: `Complex Process Migration (${manualArts.length} processes)`, weeks: `${Math.ceil(manualArts.reduce((s,a)=>s+(a.effort_days||0),0)/5)} weeks`, color: C.danger,
      effort: manualArts.reduce((s,a)=>s+(a.effort_days||0),0),
      activities: [`Architect ${manualArts.length} complex processes with Sierra Digital integration specialist`,'Re-implement custom EDI, multi-system orchestration, and advanced scripting patterns','Performance testing and load validation','End-to-end integration testing with all connected systems']
    },
    {
      num: 'Phase 5', title: 'UAT, Cutover & Hypercare', weeks: '2 weeks', color: C.navyMid,
      effort: 10,
      activities: ['User acceptance testing with SLB business team and IT','Parallel run of legacy and new IS landscape (if required)','Cutover execution — decommission legacy platform','30-day hypercare support with Sierra Digital on-site/remote']
    }
  ];

  phases.forEach((phase, i) => {
    if (y > H - 100) return;
    const ph = 86;
    fillColor(doc, C.white).rect(L, y, TW, ph).fill();
    strokeColor(doc, C.borderLight).lineWidth(0.5).rect(L, y, TW, ph).stroke();
    fillColor(doc, phase.color).rect(L, y, 5, ph).fill();

    // Phase header
    fillColor(doc, phase.color).fontSize(8).font('Helvetica-Bold')
      .text(phase.num.toUpperCase(), L+14, y+8, { characterSpacing: 1 });
    fillColor(doc, C.textPrimary).fontSize(10).font('Helvetica-Bold')
      .text(phase.title, L+14, y+20, { width: TW - 110 });
    fillColor(doc, C.textSecondary).fontSize(8).font('Helvetica')
      .text(`${phase.weeks} · ${phase.effort} days effort`, L+14, y+34, { width: TW - 110 });

    // Activities
    phase.activities.slice(0,3).forEach((act, ai) => {
      fillColor(doc, C.accent).circle(L + 14, y + 50 + ai * 12, 2).fill();
      fillColor(doc, C.textSecondary).fontSize(7.5).font('Helvetica')
        .text(act, L + 20, y + 46 + ai * 12, { width: TW - 110 });
    });

    // Effort badge
    fillColor(doc, phase.color).roundedRect(R - 90, y + 14, 82, 28, 4).fill();
    fillColor(doc, C.white).fontSize(16).font('Helvetica-Bold')
      .text(`${phase.effort}d`, R - 90 + 6, y + 18, { width: 70, align: 'center' });

    y += ph + 6;
  });

  // Total
  if (y < H - 60) {
    fillColor(doc, C.navyDark).rect(L, y, TW, 36).fill();
    fillColor(doc, C.white).fontSize(10).font('Helvetica-Bold')
      .text('TOTAL ESTIMATED MIGRATION EFFORT', L+14, y+12, { width: TW - 120 });
    fillColor(doc, C.accent).fontSize(16).font('Helvetica-Bold')
      .text(`${totalEffort + 15} days  ·  ~${Math.ceil((totalEffort + 15) / 20)} months`, R - 200, y + 10, { width: 190, align: 'right' });
  }

  buildFooter(doc, project, 4);
}

// ── PAGE 5: Artifact Inventory ────────────────────────────────────────────────

function buildArtifactInventory(doc, artifacts, project) {
  buildPageHeader(doc, 'Artifact Inventory', project);

  let y = 130;
  const rowH = 22;
  const maxPerPage = 28;

  // Column definitions
  const cols = [
    { label:'Process Name',       x:L,       w:182 },
    { label:'Domain',             x:L+188,   w:64 },
    { label:'Complexity',         x:L+258,   w:62 },
    { label:'T-Shirt',            x:L+326,   w:38, align:'center' },
    { label:'Effort',             x:L+370,   w:38, align:'center' },
    { label:'Connector',          x:L+414,   w:80 },
    { label:'Readiness',          x:L+500,   w:TW-500+L }
  ];

  // Table header
  fillColor(doc, C.navyMid).rect(L, y, TW, 22).fill();
  cols.forEach(c => {
    fillColor(doc, C.white).fontSize(7.5).font('Helvetica-Bold')
      .text(c.label, c.x + 3, y + 7, { width: c.w - 6, align: c.align || 'left' });
  });
  y += 22;

  const displayed = artifacts.slice(0, maxPerPage);
  displayed.forEach((art, i) => {
    if (y > H - 80) return;
    fillColor(doc, i % 2 === 0 ? C.white : C.accentLight).rect(L, y, TW, rowH).fill();

    const compColor = art.complexity_level === 'Simple' ? C.success : art.complexity_level === 'Complex' ? C.danger : C.warning;
    const readColor = art.readiness === 'Auto' ? C.success : art.readiness === 'Manual' ? C.danger : C.warning;

    fillColor(doc, C.textPrimary).fontSize(7.5).font('Helvetica')
      .text(truncate(art.name || '—', 30), cols[0].x+3, y+7, { width:cols[0].w-6 });
    fillColor(doc, C.textSecondary).fontSize(7).font('Helvetica')
      .text(art.domain || '—', cols[1].x+3, y+7, { width:cols[1].w-6 });
    fillColor(doc, compColor).fontSize(7).font('Helvetica-Bold')
      .text(art.complexity_level || '—', cols[2].x+3, y+7, { width:cols[2].w-6 });
    fillColor(doc, C.textSecondary).fontSize(7).font('Helvetica')
      .text(art.tshirt_size || '—', cols[3].x+3, y+7, { width:cols[3].w-6, align:'center' });
    fillColor(doc, C.textPrimary).fontSize(7).font('Helvetica-Bold')
      .text(`${art.effort_days || 0}d`, cols[4].x+3, y+7, { width:cols[4].w-6, align:'center' });
    fillColor(doc, C.textSecondary).fontSize(7).font('Helvetica')
      .text(truncate(art.primary_connector || '—', 14), cols[5].x+3, y+7, { width:cols[5].w-6 });
    fillColor(doc, readColor).fontSize(7).font('Helvetica-Bold')
      .text(art.readiness || '—', cols[6].x+3, y+7, { width: 45 });

    y += rowH;
  });

  if (artifacts.length > maxPerPage) {
    fillColor(doc, C.textSecondary).fontSize(8).font('Helvetica').font('Helvetica-Oblique')
      .text(`… and ${artifacts.length - maxPerPage} more processes. Full inventory available in digital workbook.`, L, y + 8, { width: TW });
  }

  buildFooter(doc, project, 5);
}

// ── PAGE 6: Risk Register ─────────────────────────────────────────────────────

function buildRiskRegister(doc, artifacts, project) {
  buildPageHeader(doc, 'Risk Register', project);

  let y = 130;
  const platform = (project?.platform || 'source').toUpperCase();
  const complexCount = artifacts.filter(a=>a.complexity_level==='Complex').length;
  const scriptedCount = artifacts.filter(a=>a.has_scripting).length;
  const ediCount = artifacts.filter(a=>(a.primary_connector||'').includes('AS2') || (a.domain||'').includes('EDI')).length;
  const manualCount = artifacts.filter(a=>a.readiness==='Manual').length;

  const risks = [
    {
      id:'R-01', category:'Technical', severity:'High',
      risk:`Custom Scripting Migration (${scriptedCount} processes)`,
      description:`${scriptedCount} processes contain custom ${platform === 'BOOMI' ? 'Groovy/JavaScript' : 'Java/XSLT'} scripts that require manual translation to SAP IS Groovy. Business logic embedded in scripts may not be fully documented.`,
      probability:'High', impact:'High',
      mitigation:'Schedule scripting workshops with SLB SMEs. Sierra Digital scripting stubs generated by IS Migration Tool provide starting point. Allow 2x buffer on scripted process timelines.'
    },
    {
      id:'R-02', category:'Technical', severity:ediCount>0?'High':'Medium',
      risk:`EDI / AS2 Connectivity (${ediCount} processes)`,
      description:`${ediCount} processes use AS2/EDI which requires SAP IS B2B/EDI Add-on license. EDI partner configuration, certificate exchange, and message acknowledgement flows need careful re-testing with trading partners.`,
      probability:'Medium', impact:'High',
      mitigation:'Confirm SAP IS B2B Add-on license early. Engage trading partners for AS2 connectivity testing in parallel with technical migration. Allow 3 weeks for EDI partner testing.'
    },
    {
      id:'R-03', category:'Schedule', severity:'Medium',
      risk:`Complex Process Architecture (${complexCount} processes)`,
      description:`${complexCount} complex processes require specialist architecture work. Scope creep risk if business requirements change during migration. Multi-system dependencies increase testing complexity.`,
      probability:'Medium', impact:'Medium',
      mitigation:'Fix scope for complex processes at Phase 3 start. Schedule architecture reviews at 50% and 80% complete. Use IS Migration Tool QA engine for automated validation.'
    },
    {
      id:'R-04', category:'Operational', severity:'Medium',
      risk:'Parallel Run Data Consistency',
      description:'During parallel run period, both legacy and SAP IS platforms will process transactions. Data reconciliation between platforms requires careful monitoring to avoid duplicate postings or data gaps.',
      probability:'Medium', impact:'Medium',
      mitigation:'Implement idempotency checks in all iFlows using SAP IS data store. Define clear reconciliation procedure. Limit parallel run period to maximum 2 weeks per domain.'
    },
    {
      id:'R-05', category:'Resource', severity:'Low',
      risk:'SAP BTP Tenant Configuration',
      description:'SAP BTP sub-account setup, integration suite subscription, and cloud connector configuration requires SAP Basis/BTP expertise. Delays in tenant provisioning can impact project timeline.',
      probability:'Low', impact:'High',
      mitigation:'Initiate SAP BTP tenant request immediately. Sierra Digital to provide BTP setup runbook. Target Phase 1 completion before conversion work begins.'
    },
    {
      id:'R-06', category:'Business', severity:'Low',
      risk:'Business Process Change During Migration',
      description:'Business process changes during the migration window may require rework of already-converted iFlows, particularly for Finance and Procurement integrations that are subject to policy change.',
      probability:'Low', impact:'Medium',
      mitigation:'Establish change freeze on integration-related business processes during Phases 3–4. Implement change request process for any scope changes with impact assessment.'
    }
  ];

  // Header
  fillColor(doc, C.navyMid).rect(L, y, TW, 22).fill();
  const rCols = [
    { label:'ID',         x:L,       w:32 },
    { label:'Risk',       x:L+38,    w:158 },
    { label:'Severity',   x:L+202,   w:52,  align:'center' },
    { label:'Probability',x:L+260,   w:56,  align:'center' },
    { label:'Mitigation', x:L+322,   w:TW-322+L }
  ];
  rCols.forEach(c => {
    fillColor(doc, C.white).fontSize(7.5).font('Helvetica-Bold')
      .text(c.label, c.x+3, y+7, { width:c.w-6, align:c.align||'left' });
  });
  y += 22;

  risks.forEach((risk, i) => {
    if (y > H - 80) return;
    const rh = 60;
    fillColor(doc, i%2===0 ? C.white : C.accentLight).rect(L, y, TW, rh).fill();
    const sevColor = risk.severity==='High' ? C.danger : risk.severity==='Medium' ? C.warning : C.success;
    fillColor(doc, sevColor).rect(L, y, 3, rh).fill();

    fillColor(doc, C.textSecondary).fontSize(8).font('Helvetica-Bold').text(risk.id, L+5, y+6, { width:28 });
    fillColor(doc, C.textPrimary).fontSize(8).font('Helvetica-Bold').text(risk.risk, L+38+3, y+6, { width:155 });
    fillColor(doc, C.textSecondary).fontSize(7.5).font('Helvetica').text(risk.description, L+38+3, y+18, { width:155, lineGap:1 });
    fillColor(doc, sevColor).fontSize(8).font('Helvetica-Bold').text(risk.severity, L+202+3, y+6, { width:46, align:'center' });
    fillColor(doc, C.textSecondary).fontSize(8).font('Helvetica').text(risk.probability, L+260+3, y+6, { width:50, align:'center' });
    fillColor(doc, C.textSecondary).fontSize(7.5).font('Helvetica').text(risk.mitigation, L+322+3, y+6, { width:TW-322+L-6, lineGap:1 });

    y += rh + 3;
  });

  buildFooter(doc, project, 6);
}

// ── PAGE 7: Recommendations ───────────────────────────────────────────────────

function buildRecommendations(doc, project, stats) {
  buildPageHeader(doc, 'Recommendations & Next Steps', project);

  let y = 130;
  const platform = (project?.platform || 'source').toUpperCase();

  const recs = [
    {
      priority:'1', color: C.accent, title: 'Proceed with Proof of Concept on High-Value Auto-Convert Processes',
      body: `Sierra Digital recommends an immediate 2-week POC deploying 5 Auto-Convert processes from ${platform} to SAP Integration Suite. This demonstrates value quickly, validates the SAP BTP environment, and builds team confidence before the full migration.`
    },
    {
      priority:'2', color: C.success, title: 'Confirm SAP BTP Tenant and Integration Suite Licensing',
      body: 'Ensure SAP Integration Suite subscription is active and correctly sized for message volume. Confirm B2B/EDI Add-on requirement. Sierra Digital can provide sizing guidance based on current integration volumes.'
    },
    {
      priority:'3', color: C.warning, title: 'Engage SLB SMEs for Complex Process Documentation',
      body: `Schedule knowledge transfer workshops with SLB integration team for the ${stats?.complex_count || '—'} complex processes. Document undocumented business rules in scripts before migration begins.`
    },
    {
      priority:'4', color: C.slbOrange, title: 'Establish SAP Cloud Connector to On-Premise Systems',
      body: 'Install and configure SAP Cloud Connector for RFC, IDoc, and JDBC connectivity to SAP S/4HANA and on-premise databases. This is on the critical path — must complete before any SAP-connected iFlows can be tested.'
    },
    {
      priority:'5', color: C.textSecondary, title: 'Sierra Digital Accelerators & Tooling',
      body: 'Leverage Sierra Digital IS Migration Tool (this tool) throughout the project for automated QA, iFlow package generation, and progress tracking. Reduces manual effort by 40% versus manual migration.'
    }
  ];

  recs.forEach((rec, i) => {
    const rh = 76;
    const ry = y + i * (rh + 8);
    if (ry > H - 100) return;

    fillColor(doc, C.accentLight).roundedRect(L, ry, TW, rh, 5).fill();
    fillColor(doc, rec.color).rect(L, ry, 5, rh).fill();
    fillColor(doc, rec.color).circle(L + 22, ry + 18, 12).fill();
    fillColor(doc, C.white).fontSize(11).font('Helvetica-Bold')
      .text(rec.priority, L + 16, ry + 12, { width: 12, align: 'center' });
    fillColor(doc, C.textPrimary).fontSize(10).font('Helvetica-Bold')
      .text(rec.title, L + 42, ry + 10, { width: TW - 48 });
    fillColor(doc, C.textSecondary).fontSize(9).font('Helvetica')
      .text(rec.body, L + 42, ry + 28, { width: TW - 48, lineGap: 2 });
  });

  // Closing / CTA
  const ctaY = H - 140;
  fillColor(doc, C.navyDark).roundedRect(L, ctaY, TW, 80, 6).fill();
  fillColor(doc, C.white).fontSize(13).font('Helvetica-Bold')
    .text('Ready to Begin Your SAP Integration Suite Migration?', L + 20, ctaY + 16, { width: TW - 40, align: 'center' });
  fillColor(doc, C.textSecondary).fontSize(9.5).font('Helvetica')
    .text('Contact Sierra Digital SAP Integration Suite Practice', L + 20, ctaY + 40, { width: TW - 40, align: 'center' });
  fillColor(doc, C.accent).fontSize(10).font('Helvetica-Bold')
    .text('www.sierradigital.com  ·  is-migration@sierradigital.com', L + 20, ctaY + 56, { width: TW - 40, align: 'center' });

  buildFooter(doc, project, 7);
}

// ── Shared components ─────────────────────────────────────────────────────────

function buildPageHeader(doc, title, project) {
  // Top stripe
  fillColor(doc, C.navyDark).rect(0, 0, W, 44).fill();
  fillColor(doc, C.accent).rect(0, 44, W, 3).fill();

  fillColor(doc, C.white).fontSize(9).font('Helvetica-Bold')
    .text('SIERRA DIGITAL  ·  SAP IS MIGRATION ASSESSMENT', L, 16, { characterSpacing: 0.5 });
  if (project) {
    fillColor(doc, C.textSecondary).fontSize(8).font('Helvetica')
      .text(project.customer || project.name, R - 150, 16, { width: 150, align: 'right' });
  }

  // Section title
  fillColor(doc, C.textPrimary).fontSize(18).font('Helvetica-Bold').text(title, L, 60);
  strokeColor(doc, C.borderLight).lineWidth(0.5).moveTo(L, 110).lineTo(R, 110).stroke();
}

function buildFooter(doc, project, pageNum) {
  const fy = H - 36;
  strokeColor(doc, C.borderLight).lineWidth(0.5).moveTo(L, fy).lineTo(R, fy).stroke();
  fillColor(doc, C.textSecondary).fontSize(7.5).font('Helvetica')
    .text('Sierra Digital Consulting  ·  SAP Integration Suite Practice  ·  Confidential', L, fy + 8, { width: TW - 60 });
  fillColor(doc, C.textSecondary).fontSize(7.5).font('Helvetica')
    .text(`Page ${pageNum}  ·  ${new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })}`,
      R - 80, fy + 8, { width: 80, align: 'right' });
}

// ── Utility ───────────────────────────────────────────────────────────────────

function truncate(str, len) {
  return str && str.length > len ? str.slice(0, len - 1) + '…' : str || '';
}

function getTopConnectors(artifacts, n) {
  const map = {};
  artifacts.forEach(a => {
    const c = a.primary_connector || 'HTTP/REST';
    map[c] = (map[c] || 0) + 1;
  });
  return Object.entries(map)
    .sort((a,b) => b[1]-a[1])
    .slice(0, n)
    .map(([c]) => c)
    .join(', ');
}

module.exports = { generatePDFReport };
