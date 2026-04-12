'use strict';
/**
 * Knowledge Base — S12 Real Artifact Testing Learnings
 * Patterns and bug fixes discovered during B+C alphabetical assessment pass (2026-04-11).
 * Run: node database/seed-knowledge-s12.js
 * Safe to re-run — uses UPSERT on (category, title).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('./db');

const ENTRIES = [

  // ── BUG PATTERNS FOUND IN S12 ────────────────────────────────────────────────
  {
    category: 'edge_case', platform: 'all',
    title: 'S12: Report header shows null complexity/tshirt/effort on first assess',
    tags: ['s12', 'ui', 'assessment', 'state'],
    content: `Problem: Downloaded assessment report header shows "Complexity: null (0/100)", "T-Shirt: null | Effort: 0 days"
              even though Process Metadata section inside the report shows correct values.
Root cause: state.currentArtifact is loaded from DB when the artifact detail page opens — BEFORE assess runs.
            After assess, state.currentAssessment is updated but state.currentArtifact still has stale null values.
Fix (e1193f2): Call refreshDetailHeader() after assess completes. This re-fetches artifact from DB (which now has
            updated complexity_score, tshirt_size, effort_days) and updates state.currentArtifact.
Lesson: Any action that writes back to the DB must also refresh the in-memory artifact state in the UI.`
  },

  {
    category: 'edge_case', platform: 'mulesoft',
    title: 'S12: MuleSoft All adapters: blank when connectorTypes is empty array',
    tags: ['s12', 'mulesoft', 'connectors', 'assessment'],
    content: `Problem: "All adapters: " shows blank for artifacts with no outbound connectors (Content_Based_Routing,
              Choice_Exception_Strategy). Even though primary_connector is set to HTTP.
Root cause: pd.connectorTypes = [] (empty array). In JavaScript [] is truthy, so
            (pd.connectorTypes || [artifact.primary_connector]) never fires the fallback.
            The join on an empty array produces an empty string.
Fix (e1193f2): Guard with length check: (pd.connectorTypes && pd.connectorTypes.length > 0)
              ? pd.connectorTypes : [artifact.primary_connector || 'HTTP']
Lesson: Always check .length when falling back on arrays — empty array is truthy in JS.
Note: For inbound-only MuleSoft flows (no outbound connectors), connectors_count=0 is CORRECT.
      Content_Based_Routing has HTTP listener + choice router but no outbound — this is valid.`
  },

  {
    category: 'edge_case', platform: 'tibco',
    title: 'S12: TIBCO BW5/BW6 maps_count = 0 for most artifacts',
    tags: ['s12', 'tibco', 'bw5', 'bw6', 'maps', 'assessment'],
    content: `Problem: All BW5 and most BW6 artifacts show "0 data mapping(s)" in Structural Analysis.
Root cause: In routes/artifacts.js assess backfill:
            derivedMaps = xsltProcessors + xslts.length
            BW5 extractor returns pd.mappers (not xsltTransforms). pd.mappers not included in count.
            BW6 xsltTransforms is correctly populated but xsltProcessors (processors with type=xslt) may be 0.
Fix (e1193f2): derivedMaps now = xsltProcessors + xslts.length + mappers.length
              where mappers = platformData.mappers || []
Expected results after fix:
  BW6_Logging_Service: 1 map (xsltTransform found) ✅ was already working
  BW5 artifacts: depends on pd.mappers count from BW5 extractor
  BW6 Credit* artifacts: depends on XSLT in extensionActivity inputBinding`
  },

  {
    category: 'edge_case', platform: 'tibco-bw6',
    title: 'S12: BW6 extensionActivity JDBC not detected as connector type',
    tags: ['s12', 'bw6', 'jdbc', 'connectors', 'extractor'],
    content: `Problem: BW6_Credit_DB_Lookup has steps: scope → QueryRecords → UpdatePulls → Throw (JDBC pattern)
              but assessment shows "Primary connector: HTTP" and "All adapters: HTTP".
Root cause: extractReceiverConfigs() in iflow-generator-tibco-bw6.js only scans BPEL <invoke> elements
            for partnerLink/operation to determine connector type.
            BW6 JDBC activities use <extensionActivity> with activityTypeID="bw.jdbc.QueryActivity" —
            these are NOT standard BPEL <invoke> elements and were invisible to the receiver config extractor.
Fix (e1193f2): After building processor list, also scan proc.config.connType (set by buildProcessor()
              which correctly maps bw.jdbc.* → 'invoke-jdbc' → connType:'JDBC').
              These are added to connSet before building result.connectorTypes.
Key fact: BW6 activities are in extensionActivity blocks with BWActivity[0].$.activityTypeID.
          Always use bw6ActivityRole() + buildProcessor() → proc.config.connType pipeline for connector detection.`
  },

  // ── PLATFORM PATTERNS CONFIRMED IN S12 ────────────────────────────────────────
  {
    category: 'platform_note', platform: 'tibco-bw5',
    title: 'S12: BW5 SOAP Gateway — all 4 KPN artifacts confirmed HTTP-based',
    tags: ['s12', 'bw5', 'soap', 'http', 'kpn'],
    content: `All 4 BW5 KPN SOAP Gateway artifacts correctly show Primary connector: HTTP.
This is correct — BW5 SOAP gateway runs over HTTP transport (SOAP over HTTP).
Artifacts tested: BW5_Common_SOAP_Handler (22 steps), BW5_Startup_SOAP_Gateway (4 steps),
                  BW5_Invalid_Data_Handler (2 steps), BW5_Get_WSDL (7 steps).
Step counts extracted correctly from pd:activity elements.
Adapter count: 1 (HTTP) for all — correct for SOAP/HTTP listener pattern.
Maps count: 0 for all — to be verified after e1193f2 fix (pd.mappers not yet confirmed populated for BW5).
Readiness: BW5_Common_SOAP_Handler shows "Auto" (22 steps → complexity 100 but readiness can be Auto if no
           unsupported connectors). Others show "Manual" — expected for SOAP complexity.
IS mapping: SOAP/HTTP trigger → IS HTTPS Sender Adapter + SOAP-to-REST conversion required.`
  },

  {
    category: 'platform_note', platform: 'tibco-bw6',
    title: 'S12: BW6 Credit App — scope-only step extraction gap',
    tags: ['s12', 'bw6', 'scope', 'extraction', 'gap'],
    content: `BW6_Credit_App_Main and BW6_Credit_Check_Backend both show only 1 step: "scope".
This means the BW6 extractor is finding the scope container but not walking inside it to extract child activities.
Expected: scope should contain HTTP send/receive activities, mapper activities etc.
Gap location: extractActivities() in iflow-generator-tibco-bw6.js — walk() function may not recurse into <scope> elements.
S14 fix needed: Ensure walk() visits scope/scope children as first-class activity containers.
Credit_Check_Backend correctly shows "2 sub-process/library dependencies" — subprocess detection works.
BW6_Credit_DB_Lookup correctly shows inner activities: scope → QueryRecords → UpdatePulls → Throw
  → suggests scope walking works for some patterns but not others. Investigate.`
  },

  {
    category: 'conversion_pattern', platform: 'mulesoft',
    title: 'S12: MuleSoft inbound-only flows — correct to show 0 outbound connectors',
    tags: ['s12', 'mulesoft', 'choice', 'router', 'connectors'],
    content: `Verified: Content_Based_Routing and Choice_Exception_Strategy correctly show 0 outbound connectors.
These flows use: HTTP Listener (inbound) → Choice Router → Set Payload → (return response)
No outbound connections to external systems — all branching is internal.
IS mapping: HTTPS Sender Adapter (inbound) → Router step (Content-Based Routing) → Message End Event.
No Receiver Adapter needed — response is returned directly.
Assessment should say: "0 adapter connection(s) configured" (correct).
The "All adapters:" field showing the primary inbound adapter (HTTP) is sufficient context.
Do NOT force connectors_count > 0 for inbound-only flows — 0 is semantically correct.`
  },

  {
    category: 'conversion_pattern', platform: 'mulesoft',
    title: 'S12: MuleSoft MongoDB connector — UNMAPPED_CONNECTOR flag not yet raised',
    tags: ['s12', 'mulesoft', 'mongodb', 'unmapped', 's14-gap'],
    content: `CSV_To_MongoDB artifact: MongoDB connector NOT yet detected or flagged as UNMAPPED_CONNECTOR.
Expected: connectorTypes should include 'MongoDB', quality engine should set UNMAPPED_CONNECTOR flag.
Current state: MuleSoft extractor does not yet recognize mongodb:* element types from raw_xml.
After xml2js stripPrefix: mongodb:outbound-endpoint → 'outbound-endpoint' (generic — loses mongo identity).
S14 fix needed in iflow-generator-mulesoft.js:
  - Build globalConnectorMap from root-level <mongodb:config> elements
  - Resolve outbound-endpoint connector-ref → globalConnectorMap → 'MongoDB'
  - Add 'MongoDB' to connectorTypes
  - Quality engine will then flag UNMAPPED_CONNECTOR automatically
IS note: No native MongoDB adapter in SAP IS — recommend HTTPS Receiver Adapter to MongoDB Atlas REST API.`
  },

  {
    category: 'sprint_decision', platform: 'all',
    title: 'S12 approach: fix-in-parallel with alphabetical testing',
    tags: ['s12', 'process', 'sprint', 'approach'],
    content: `Testing approach agreed 2026-04-11:
- Sriman tests artifacts alphabetically (B→C→D→...) and reports assessment files
- Claude analyzes all reports in batch, identifies systemic bugs, fixes immediately
- Deploy fix to Azure, then Sriman re-tests and continues to next letter
- This is more efficient than: test all → report all → fix all
  because systemic bugs (like null header) would appear in every artifact otherwise.
S12 B+C pass found: 4 systemic bugs all fixed in commit e1193f2.
After each fix batch: TESTING_REPORT.md and KB (this seed) are updated before next test pass.
Sprint S12 is: Assessment only. Convert testing is S13.`
  }

];

async function seedKnowledgeS12() {
  let inserted = 0, updated = 0;

  for (const entry of ENTRIES) {
    const existing = await pool.query(
      'SELECT id FROM knowledge_base WHERE category = $1 AND title = $2',
      [entry.category, entry.title]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        'UPDATE knowledge_base SET content = $1, platform = $2, tags = $3, updated_at = NOW() WHERE id = $4',
        [entry.content, entry.platform || null, entry.tags || [], existing.rows[0].id]
      );
      updated++;
    } else {
      await pool.query(
        `INSERT INTO knowledge_base (category, title, content, platform, tags, source)
         VALUES ($1, $2, $3, $4, $5, 'seed_s12')`,
        [entry.category, entry.title, entry.content, entry.platform || null, entry.tags || []]
      );
      inserted++;
    }
  }

  console.log(`S12 KB seed complete: ${inserted} new, ${updated} updated, ${ENTRIES.length} total entries.`);
  await pool.end();
}

seedKnowledgeS12().catch(err => {
  console.error('S12 seed failed:', err.message);
  process.exit(1);
});
