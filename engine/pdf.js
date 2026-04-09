/**
 * Assessment Report Generator — Sprint 3
 * Generates a Sierra Digital branded HTML report, served as text/html.
 * Opens in a new browser tab — user clicks "Save as PDF" from print dialog.
 *
 * Zero external dependencies — no pdfkit, no puppeteer, no fontkit.
 * Avoids Azure startup hang caused by ESM-only fontkit in pdfkit@0.18+.
 */

function generateHTMLReport(project, artifacts, stats) {
  const platform     = (project.platform || 'unknown').toUpperCase();
  const customer     = project.customer || project.name;
  const consultant   = project.consultant || 'Sierra Digital';
  const today        = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'long', year:'numeric' });

  const total        = parseInt(stats.total || 0);
  const simpleCount  = parseInt(stats.simple_count  || 0);
  const mediumCount  = parseInt(stats.medium_count  || 0);
  const complexCount = parseInt(stats.complex_count || 0);
  const autoCount    = parseInt(stats.auto_count    || 0);
  const partialCount = parseInt(stats.partial_count || 0);
  const manualCount  = parseInt(stats.manual_count  || 0);
  const effortDays   = parseInt(stats.total_effort_days || 0);
  const months       = Math.ceil(effortDays / 20);

  const autoPct    = total > 0 ? Math.round((autoCount    / total) * 100) : 0;
  const partialPct = total > 0 ? Math.round((partialCount / total) * 100) : 0;
  const manualPct  = total > 0 ? Math.round((manualCount  / total) * 100) : 0;
  const simplePct  = total > 0 ? Math.round((simpleCount  / total) * 100) : 0;
  const mediumPct  = total > 0 ? Math.round((mediumCount  / total) * 100) : 0;
  const complexPct = total > 0 ? Math.round((complexCount / total) * 100) : 0;

  // Domain breakdown
  const domainMap = {};
  artifacts.forEach(a => {
    const d = a.domain || 'Other';
    if (!domainMap[d]) domainMap[d] = { simple:0, medium:0, complex:0, effort:0, count:0, auto:0 };
    domainMap[d][(a.complexity_level||'Medium').toLowerCase()]++;
    domainMap[d].effort += (parseInt(a.effort_days) || 0);
    domainMap[d].count++;
    if (a.readiness === 'Auto') domainMap[d].auto++;
  });

  // Connector breakdown
  const connMap = {};
  artifacts.forEach(a => { const c = a.primary_connector || 'HTTP/REST'; connMap[c] = (connMap[c]||0)+1; });
  const topConns = Object.entries(connMap).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const maxConn  = topConns[0]?.[1] || 1;

  // Risk items
  const scriptedCount = artifacts.filter(a=>a.has_scripting).length;
  const ediCount      = artifacts.filter(a=>(a.primary_connector||'').includes('AS2')).length;

  const risks = [
    { id:'R-01', sev:'High',   category:'Technical',   title:`Custom Scripting (${scriptedCount} processes)`,         mitigation:'Use IS Migration Tool script stubs as starting point. Schedule SME knowledge transfer workshops.' },
    { id:'R-02', sev:ediCount>0?'High':'Medium', category:'Technical', title:`EDI/AS2 Connectivity (${ediCount} processes)`, mitigation:'Confirm SAP IS B2B Add-on license early. Allow 3 weeks for trading partner AS2 testing.' },
    { id:'R-03', sev:'Medium', category:'Schedule',    title:`Complex Processes (${complexCount} require architecture)`, mitigation:'Fix scope at Phase 3 start. Use IS Migration Tool QA engine for automated validation.' },
    { id:'R-04', sev:'Medium', category:'Operational', title:'Parallel Run Data Consistency',                            mitigation:'Implement idempotency checks in all iFlows. Limit parallel run to 2 weeks per domain.' },
    { id:'R-05', sev:'Low',    category:'Resource',    title:'SAP BTP Tenant Provisioning',                             mitigation:'Initiate BTP tenant request immediately — on critical path before conversion begins.' },
    { id:'R-06', sev:'Low',    category:'Business',    title:'Scope Change During Migration',                           mitigation:'Establish integration change freeze during Phases 3–4. Formal change request process required.' }
  ];

  const sevColor = { High:'#DC3545', Medium:'#F59E0B', Low:'#28A745' };

  // Artifact rows (top 40 for print)
  const artRows = artifacts.slice(0, 50).map((a, i) => {
    const compColor = a.complexity_level==='Simple' ? '#28A745' : a.complexity_level==='Complex' ? '#DC3545' : '#F59E0B';
    const readColor = a.readiness==='Auto' ? '#28A745' : a.readiness==='Manual' ? '#DC3545' : '#F59E0B';
    return `<tr style="background:${i%2===0?'#fff':'#F8FAFF'}">
      <td style="padding:5px 8px;font-size:11px;font-weight:600;color:#1A1A2E">${esc(a.name||'—')}</td>
      <td style="padding:5px 8px;font-size:11px;color:#6B7280">${esc(a.domain||'—')}</td>
      <td style="padding:5px 8px;font-size:11px;color:${compColor};font-weight:700">${esc(a.complexity_level||'—')}</td>
      <td style="padding:5px 8px;font-size:11px;text-align:center;color:#6B7280">${esc(a.tshirt_size||'—')}</td>
      <td style="padding:5px 8px;font-size:11px;text-align:center;font-weight:700">${parseInt(a.effort_days)||0}d</td>
      <td style="padding:5px 8px;font-size:11px;color:#6B7280">${esc(a.primary_connector||'—')}</td>
      <td style="padding:5px 8px;font-size:11px;color:${readColor};font-weight:700">${esc(a.readiness||'—')}</td>
    </tr>`;
  }).join('');

  const domainRows = Object.entries(domainMap).sort((a,b)=>b[1].count-a[1].count).map(([d, v], i) => {
    const autoPctD = v.count > 0 ? Math.round((v.auto/v.count)*100) : 0;
    const pc = autoPctD >= 60 ? '#28A745' : autoPctD >= 30 ? '#F59E0B' : '#DC3545';
    return `<tr style="background:${i%2===0?'#fff':'#F8FAFF'}">
      <td style="padding:6px 10px;font-size:12px;font-weight:600">${esc(d)}</td>
      <td style="padding:6px 10px;font-size:12px;text-align:center">${v.count}</td>
      <td style="padding:6px 10px;font-size:12px;text-align:center;color:#28A745;font-weight:600">${v.simple}</td>
      <td style="padding:6px 10px;font-size:12px;text-align:center;color:#F59E0B;font-weight:600">${v.medium}</td>
      <td style="padding:6px 10px;font-size:12px;text-align:center;color:#DC3545;font-weight:600">${v.complex}</td>
      <td style="padding:6px 10px;font-size:12px;text-align:center;font-weight:700">${v.effort}d</td>
      <td style="padding:6px 10px;font-size:12px;text-align:center;color:${pc};font-weight:700">${autoPctD}%</td>
    </tr>`;
  }).join('');

  const connBars = topConns.map(([c, n]) => {
    const w = Math.round((n/maxConn)*100);
    return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <div style="width:180px;font-size:11px;color:#1A1A2E;font-weight:500;text-align:right">${esc(c)}</div>
      <div style="flex:1;background:#E5E7EB;border-radius:3px;height:18px;position:relative">
        <div style="width:${w}%;background:#0066CC;height:100%;border-radius:3px"></div>
      </div>
      <div style="width:24px;font-size:11px;font-weight:700;color:#0066CC">${n}</div>
    </div>`;
  }).join('');

  const riskRows = risks.map(r => `<tr>
    <td style="padding:8px 10px;font-size:11px;font-weight:700;color:#6B7280">${r.id}</td>
    <td style="padding:8px 10px">
      <div style="font-size:11px;font-weight:700;color:#1A1A2E;margin-bottom:2px">${esc(r.title)}</div>
    </td>
    <td style="padding:8px 10px;text-align:center"><span style="background:${sevColor[r.sev]}20;color:${sevColor[r.sev]};padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700">${r.sev}</span></td>
    <td style="padding:8px 10px;font-size:10.5px;color:#6B7280">${esc(r.mitigation)}</td>
  </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SAP IS Migration Assessment — ${esc(customer)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;color:#1A1A2E;background:#fff;font-size:13px}
  @media print{
    body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .no-print{display:none!important}
    .page-break{page-break-before:always}
    @page{margin:15mm 12mm;size:A4}
  }
  .print-bar{position:fixed;top:0;left:0;right:0;background:#0A1929;color:#fff;padding:10px 24px;display:flex;align-items:center;justify-content:space-between;z-index:100;font-size:13px}
  .print-bar button{background:#0066CC;color:#fff;border:none;padding:8px 20px;border-radius:5px;cursor:pointer;font-size:13px;font-weight:600}
  .print-bar button:hover{background:#0052A3}
  .content{padding-top:52px}

  /* Cover */
  .cover{background:#0A1929;color:#fff;padding:48px 56px 40px;min-height:320px}
  .sd-tag{font-size:10px;letter-spacing:2px;color:#0066CC;font-weight:700;text-transform:uppercase;margin-bottom:6px}
  .cover h1{font-size:32px;font-weight:700;line-height:1.2;margin:12px 0 8px}
  .cover .sub{font-size:15px;color:#94A3B8;margin-bottom:28px}
  .cover-meta{background:#1C2B3A;border-radius:8px;padding:20px 28px;margin-top:28px;display:flex;gap:40px;flex-wrap:wrap}
  .cover-meta-item label{font-size:9px;letter-spacing:1px;color:#64748B;text-transform:uppercase;display:block;margin-bottom:4px}
  .cover-meta-item value{font-size:15px;font-weight:700;color:#fff}

  /* Stat cards */
  .stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:20px 0}
  .stat-card{background:#F0F7FF;border:1px solid #BFDBFE;border-radius:8px;padding:16px;text-align:center}
  .stat-card .val{font-size:28px;font-weight:800;color:#0066CC}
  .stat-card .lbl{font-size:10px;color:#6B7280;margin-top:4px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}

  /* Section */
  .section{padding:32px 56px;border-bottom:1px solid #E5E7EB}
  .section:last-child{border-bottom:none}
  .section-title{font-size:20px;font-weight:800;color:#0A1929;margin-bottom:4px;display:flex;align-items:center;gap:10px}
  .section-title::before{content:'';display:block;width:4px;height:24px;background:#0066CC;border-radius:2px;flex-shrink:0}
  .section-sub{font-size:12px;color:#6B7280;margin-bottom:20px}

  /* Readiness bar */
  .readiness-bar-wrap{margin:16px 0}
  .readiness-bar{height:28px;border-radius:6px;overflow:hidden;display:flex}
  .readiness-bar .seg{display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff}

  /* Tables */
  table{width:100%;border-collapse:collapse}
  th{background:#0A1929;color:#fff;padding:8px 10px;font-size:11px;text-align:left;font-weight:700;letter-spacing:.3px}
  td{border-bottom:1px solid #E5E7EB}

  /* Phases */
  .phase{display:flex;gap:16px;padding:14px 0;border-bottom:1px solid #F3F4F6}
  .phase:last-child{border:none}
  .phase-num{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;flex-shrink:0;margin-top:2px}
  .phase-body{flex:1}
  .phase-title{font-size:13px;font-weight:700;color:#1A1A2E}
  .phase-meta{font-size:11px;color:#6B7280;margin:2px 0 6px}
  .phase-acts{font-size:11px;color:#6B7280;padding-left:14px}
  .phase-acts li{margin-bottom:2px}
  .phase-effort{font-size:22px;font-weight:800;padding:0 16px;color:#0066CC;align-self:center;min-width:60px;text-align:right}

  /* Findings */
  .findings{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0}
  .finding{background:#F0F7FF;border-left:4px solid #0066CC;border-radius:0 6px 6px 0;padding:12px 14px}
  .finding h4{font-size:12px;font-weight:700;color:#1A1A2E;margin-bottom:4px}
  .finding p{font-size:11px;color:#6B7280;line-height:1.5}

  /* CTA */
  .cta{background:#0A1929;color:#fff;padding:28px 56px;text-align:center}
  .cta h3{font-size:18px;font-weight:700;margin-bottom:8px}
  .cta p{font-size:12px;color:#94A3B8;margin-bottom:4px}
  .cta a{color:#60A5FA;text-decoration:none;font-weight:600}

  /* Confidential footer */
  .footer{background:#F8FAFF;border-top:1px solid #E5E7EB;padding:12px 56px;display:flex;justify-content:space-between;font-size:10px;color:#9CA3AF}
</style>
</head>
<body>

<!-- Print bar (screen only) -->
<div class="print-bar no-print">
  <div>
    <strong>SAP IS Migration Assessment</strong> — ${esc(customer)}
    <span style="margin-left:16px;color:#94A3B8;font-size:12px">${today}</span>
  </div>
  <button onclick="window.print()">⬇ Save as PDF / Print</button>
</div>

<div class="content">

<!-- ── COVER ────────────────────────────────────────────────────────────── -->
<div class="cover">
  <div class="sd-tag">Sierra Digital · SAP Integration Suite Practice</div>
  <h1>SAP Integration Suite<br>Migration Assessment</h1>
  <div class="sub">Comprehensive Platform Migration Analysis &amp; Roadmap</div>
  <div class="cover-meta">
    <div class="cover-meta-item"><label>Prepared For</label><value>${esc(customer)}</value></div>
    <div class="cover-meta-item"><label>Project</label><value>${esc(project.name)}</value></div>
    <div class="cover-meta-item"><label>Source Platform</label><value>${platform}</value></div>
    <div class="cover-meta-item"><label>Consultant</label><value>${esc(consultant)}</value></div>
    <div class="cover-meta-item"><label>Report Date</label><value>${today}</value></div>
    <div class="cover-meta-item"><label>Total Processes</label><value>${total}</value></div>
  </div>
</div>

<!-- ── EXECUTIVE SUMMARY ─────────────────────────────────────────────────── -->
<div class="section">
  <div class="section-title">Executive Summary</div>
  <div class="section-sub">Migration assessment overview and key findings</div>

  <p style="font-size:12.5px;line-height:1.7;color:#374151;margin-bottom:20px">
    Sierra Digital has completed a comprehensive technical assessment of <strong>${esc(customer)}</strong>'s
    ${platform} integration landscape as part of the planned migration to SAP Integration Suite (SAP BTP).
    This report presents findings, complexity analysis, risk assessment, and recommended migration roadmap
    across <strong>${total} integration processes</strong> spanning ${Object.keys(domainMap).length} business domains.
  </p>

  <div class="stat-grid">
    <div class="stat-card"><div class="val">${total}</div><div class="lbl">Total Processes</div></div>
    <div class="stat-card"><div class="val" style="color:#28A745">${autoPct}%</div><div class="lbl">Auto-Convert Ready</div></div>
    <div class="stat-card"><div class="val">${effortDays}d</div><div class="lbl">Total Effort</div></div>
    <div class="stat-card"><div class="val">~${months}mo</div><div class="lbl">Est. Duration</div></div>
  </div>

  <!-- Readiness bar -->
  <div class="readiness-bar-wrap">
    <div style="font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Migration Readiness</div>
    <div class="readiness-bar">
      <div class="seg" style="width:${autoPct}%;background:#28A745">${autoPct > 8 ? autoPct+'%' : ''}</div>
      <div class="seg" style="width:${partialPct}%;background:#F59E0B">${partialPct > 8 ? partialPct+'%' : ''}</div>
      <div class="seg" style="width:${manualPct}%;background:#DC3545">${manualPct > 8 ? manualPct+'%' : ''}</div>
    </div>
    <div style="display:flex;gap:24px;margin-top:8px">
      <div style="display:flex;align-items:center;gap:6px;font-size:11px"><div style="width:10px;height:10px;background:#28A745;border-radius:2px"></div>Auto-Convert: ${autoCount}</div>
      <div style="display:flex;align-items:center;gap:6px;font-size:11px"><div style="width:10px;height:10px;background:#F59E0B;border-radius:2px"></div>Semi-Auto: ${partialCount}</div>
      <div style="display:flex;align-items:center;gap:6px;font-size:11px"><div style="width:10px;height:10px;background:#DC3545;border-radius:2px"></div>Manual: ${manualCount}</div>
    </div>
  </div>

  <!-- Key findings -->
  <div class="findings">
    <div class="finding">
      <h4>✅ ${autoCount} Processes — Direct Auto-Conversion</h4>
      <p>${autoPct}% of integration processes can be auto-converted to SAP IS iFlows using the Sierra Digital Migration Tool, significantly reducing project risk and timeline.</p>
    </div>
    <div class="finding" style="border-color:#DC3545">
      <h4 style="color:#DC3545">⚠ ${complexCount} Complex Processes Require Review</h4>
      <p>${complexCount} processes contain custom scripting, complex EDI mapping, or multi-system orchestration patterns requiring specialist architecture and testing effort.</p>
    </div>
    <div class="finding" style="border-color:#F59E0B">
      <h4 style="color:#F59E0B">⏱ ${effortDays} Person-Days Total Effort</h4>
      <p>Full migration effort across ${total} processes estimated at ${effortDays} person-days (~${months} months), covering conversion, testing, and go-live activities.</p>
    </div>
    <div class="finding" style="border-color:#FF6600">
      <h4 style="color:#FF6600">★ Native SAP IS Adapters Available</h4>
      <p>All identified connector types have native SAP IS adapters — eliminating third-party middleware licensing costs post-migration to SAP BTP.</p>
    </div>
  </div>
</div>

<!-- ── COMPLEXITY BREAKDOWN ──────────────────────────────────────────────── -->
<div class="section page-break">
  <div class="section-title">Complexity &amp; Effort Analysis</div>
  <div class="section-sub">Breakdown by domain and complexity level</div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-bottom:24px">
    <div>
      <div style="font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">By Complexity</div>
      ${[
        { label:'Simple (Auto-Convert)', count:simpleCount,  pct:simplePct,  color:'#28A745' },
        { label:'Medium (Semi-Auto)',     count:mediumCount,  pct:mediumPct,  color:'#F59E0B' },
        { label:'Complex (Manual Work)',  count:complexCount, pct:complexPct, color:'#DC3545' }
      ].map(r => `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <div style="width:12px;height:12px;background:${r.color};border-radius:2px;flex-shrink:0"></div>
          <div style="flex:1;font-size:12px">${r.label}</div>
          <div style="font-size:16px;font-weight:800;color:${r.color};min-width:28px;text-align:right">${r.count}</div>
          <div style="width:80px;background:#E5E7EB;height:12px;border-radius:3px"><div style="width:${r.pct}%;height:100%;background:${r.color};border-radius:3px"></div></div>
          <div style="font-size:11px;color:#6B7280;min-width:30px">${r.pct}%</div>
        </div>`).join('')}
    </div>
    <div>
      <div style="font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">Primary Connectors</div>
      ${connBars}
    </div>
  </div>

  <div style="font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Domain Breakdown</div>
  <table>
    <thead><tr>
      <th>Domain</th><th style="text-align:center">Total</th>
      <th style="text-align:center;color:#86EFAC">Simple</th>
      <th style="text-align:center;color:#FCD34D">Medium</th>
      <th style="text-align:center;color:#FCA5A5">Complex</th>
      <th style="text-align:center">Effort</th>
      <th style="text-align:center">Auto%</th>
    </tr></thead>
    <tbody>${domainRows}</tbody>
  </table>
</div>

<!-- ── MIGRATION ROADMAP ─────────────────────────────────────────────────── -->
<div class="section page-break">
  <div class="section-title">Migration Roadmap &amp; Timeline</div>
  <div class="section-sub">Recommended phased migration approach for ${platform} → SAP Integration Suite</div>

  ${[
    { num:'1', color:'#0066CC', bg:'#DBEAFE', title:'Foundation & Environment Setup', weeks:'2 weeks', effort:5,
      acts:['SAP BTP tenant provisioning and IS subscription activation','Connection & credential configuration for all identified adapters','Import auto-converted iFlow packages from Sierra Digital Migration Tool','Smoke testing and connectivity validation in DEV landscape'] },
    { num:'2', color:'#28A745', bg:'#DCFCE7', title:`Auto-Conversion (${autoCount} processes)`, weeks:`${Math.ceil(autoCount/5)||2} weeks`, effort:artifacts.filter(a=>a.readiness==='Auto').reduce((s,a)=>s+(parseInt(a.effort_days)||0),0),
      acts:[`Deploy ${autoCount} auto-converted iFlow packages to DEV landscape`,'Configure externalized parameters (parameters.prop) per iFlow','Execute functional test cases using IS Migration Tool validation engine','Promote through TEST to PROD using SAP BTP transport management'] },
    { num:'3', color:'#F59E0B', bg:'#FEF3C7', title:`Semi-Auto Migration (${partialCount} processes)`, weeks:`${Math.ceil(partialCount/4)||3} weeks`, effort:artifacts.filter(a=>a.readiness==='Partial').reduce((s,a)=>s+(parseInt(a.effort_days)||0),0),
      acts:[`Complete message mapping for ${partialCount} semi-auto processes in IS Integration Designer`,'Migrate Groovy script stubs with full business logic implementation','Configure standard IS error handling and alerting','Integration testing with connected systems in TEST landscape'] },
    { num:'4', color:'#DC3545', bg:'#FEE2E2', title:`Complex Process Migration (${manualCount} processes)`, weeks:`${Math.ceil(manualCount/2)||4} weeks`, effort:artifacts.filter(a=>a.readiness==='Manual').reduce((s,a)=>s+(parseInt(a.effort_days)||0),0),
      acts:[`Architect ${manualCount} complex processes with Sierra Digital specialist`,'Re-implement EDI, multi-system orchestration, and advanced scripting patterns','Performance testing and load validation','End-to-end integration testing with all connected systems'] },
    { num:'5', color:'#6B7280', bg:'#F3F4F6', title:'UAT, Cutover & Hypercare', weeks:'2 weeks', effort:10,
      acts:['User acceptance testing with business team and IT','Parallel run of legacy and new IS landscape (if required)','Cutover execution — decommission legacy platform','30-day hypercare support with Sierra Digital on-site/remote'] }
  ].map(p => `
    <div class="phase">
      <div class="phase-num" style="background:${p.bg};color:${p.color}">${p.num}</div>
      <div class="phase-body">
        <div class="phase-title">${p.title}</div>
        <div class="phase-meta">${p.weeks} · ${p.effort} days effort</div>
        <ul class="phase-acts">${p.acts.map(a=>`<li>${esc(a)}</li>`).join('')}</ul>
      </div>
      <div class="phase-effort">${p.effort}d</div>
    </div>`).join('')}

  <div style="background:#0A1929;border-radius:8px;padding:16px 20px;margin-top:20px;display:flex;justify-content:space-between;align-items:center">
    <div style="color:#94A3B8;font-size:13px;font-weight:700">TOTAL ESTIMATED MIGRATION EFFORT</div>
    <div style="color:#60A5FA;font-size:20px;font-weight:800">${effortDays + 15} days &nbsp;·&nbsp; ~${Math.ceil((effortDays+15)/20)} months</div>
  </div>
</div>

<!-- ── ARTIFACT INVENTORY ────────────────────────────────────────────────── -->
<div class="section page-break">
  <div class="section-title">Artifact Inventory</div>
  <div class="section-sub">All ${total} integration processes identified for migration</div>
  <table>
    <thead><tr>
      <th>Process Name</th><th>Domain</th><th>Complexity</th>
      <th style="text-align:center">T-Shirt</th><th style="text-align:center">Effort</th>
      <th>Connector</th><th>Readiness</th>
    </tr></thead>
    <tbody>${artRows}</tbody>
  </table>
  ${artifacts.length > 50 ? `<div style="font-size:11px;color:#6B7280;font-style:italic;margin-top:8px">Showing 50 of ${artifacts.length} processes. Full inventory available in the IS Migration Tool.</div>` : ''}
</div>

<!-- ── RISK REGISTER ─────────────────────────────────────────────────────── -->
<div class="section page-break">
  <div class="section-title">Risk Register</div>
  <div class="section-sub">Identified migration risks with severity and recommended mitigations</div>
  <table>
    <thead><tr><th style="width:50px">ID</th><th>Risk</th><th style="width:80px;text-align:center">Severity</th><th>Mitigation</th></tr></thead>
    <tbody>${riskRows}</tbody>
  </table>
</div>

<!-- ── RECOMMENDATIONS ───────────────────────────────────────────────────── -->
<div class="section page-break">
  <div class="section-title">Recommendations &amp; Next Steps</div>
  <div class="section-sub">Sierra Digital recommended actions to initiate the migration</div>
  ${[
    { n:'1', c:'#0066CC', title:'Proceed with Proof of Concept on High-Value Auto-Convert Processes',
      body:`Sierra Digital recommends an immediate 2-week POC deploying 5 Auto-Convert processes from ${platform} to SAP Integration Suite. This demonstrates value quickly, validates the SAP BTP environment, and builds team confidence before the full migration.` },
    { n:'2', c:'#28A745', title:'Confirm SAP BTP Tenant and Integration Suite Licensing',
      body:'Ensure SAP Integration Suite subscription is active and correctly sized for message volume. Confirm B2B/EDI Add-on requirement for AS2/EDI processes. Sierra Digital can provide sizing guidance based on current integration volumes.' },
    { n:'3', c:'#F59E0B', title:'Engage SMEs for Complex Process Documentation',
      body:`Schedule knowledge transfer workshops with the integration team for the ${complexCount} complex processes. Document undocumented business rules in scripts before migration begins to prevent knowledge loss.` },
    { n:'4', c:'#FF6600', title:'Establish SAP Cloud Connector to On-Premise Systems',
      body:'Install and configure SAP Cloud Connector for RFC, IDoc, and JDBC connectivity to SAP S/4HANA and on-premise databases. This is on the critical path — must complete before any SAP-connected iFlows can be tested.' },
    { n:'5', c:'#6B7280', title:'Leverage Sierra Digital IS Migration Tool Throughout Project',
      body:'Continue using this tool for automated QA validation, iFlow package generation, and progress tracking across all 5 migration phases. Sierra Digital accelerators reduce manual effort by ~40% versus conventional migration approaches.' }
  ].map(r => `
    <div style="display:flex;gap:14px;padding:14px 0;border-bottom:1px solid #F3F4F6">
      <div style="width:30px;height:30px;background:${r.c}20;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;color:${r.c};flex-shrink:0">${r.n}</div>
      <div>
        <div style="font-size:13px;font-weight:700;color:#1A1A2E;margin-bottom:4px">${esc(r.title)}</div>
        <div style="font-size:12px;color:#6B7280;line-height:1.6">${esc(r.body)}</div>
      </div>
    </div>`).join('')}
</div>

<!-- ── CTA ───────────────────────────────────────────────────────────────── -->
<div class="cta no-print">
  <h3>Ready to Begin Your SAP Integration Suite Migration?</h3>
  <p>Contact Sierra Digital's SAP Integration Suite Practice</p>
  <p><a href="https://www.sierradigital.com">www.sierradigital.com</a> &nbsp;·&nbsp; <a href="mailto:is-migration@sierradigital.com">is-migration@sierradigital.com</a></p>
</div>

<div class="footer">
  <span>Sierra Digital Consulting &nbsp;·&nbsp; SAP Integration Suite Practice &nbsp;·&nbsp; Confidential</span>
  <span>Generated ${today} &nbsp;·&nbsp; IS Migration Tool</span>
</div>

</div><!-- /content -->

<script>
  // Auto-open print dialog when ?print=1 is in URL (used by download flow)
  if (new URLSearchParams(location.search).get('print') === '1') {
    setTimeout(() => window.print(), 800);
  }
</script>
</body>
</html>`;
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { generateHTMLReport };
