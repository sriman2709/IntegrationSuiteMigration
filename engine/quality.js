'use strict';
/**
 * Conversion Quality Engine (Sprint 10)
 *
 * Produces a real completeness score and structured flags from actual
 * platform data (processors, connectorTypes, transforms, scripts).
 *
 * Score = (auto_steps / total_steps) * 100
 *
 * Step weights:
 *   xslt            → 100% (XSLT 1.0 native in SAP IS — zero translation)
 *   contentModifier → 100% (trivial)
 *   log             → 100%
 *   router          →  90%
 *   processCall     →  85% (separate iFlow needed)
 *   splitter/aggr   →  85%
 *   invoke (mapped) → 100% (JDBC/HTTP/JMS/SFTP/SAP/SMTP)
 *   invoke (unmapped)→  0% (MongoDB/Kafka/S3/AMQP/LDAP — no native adapter)
 *   javaScript      →  40% (stub generated, dev must implement)
 *   transform-msg   →  40% (Groovy stub, DW preserved as comment)
 *   scope/throw/note→  70%
 *
 * Flag types → stored in artifacts.conversion_notes JSONB
 */

// ── Connectors with no native SAP IS adapter ──────────────────────────────────
const UNMAPPED_CONNECTORS = new Set(['MongoDB', 'Kafka', 'S3', 'AMQP', 'LDAP', 'CMIS', 'WMQ', 'RabbitMQ']);

// ── Main entry ────────────────────────────────────────────────────────────────
function runQualityAnalysis(artifact, platformData) {
  const flags       = buildConversionFlags(artifact, platformData);
  const score       = calculateCompleteness(artifact, platformData, flags);
  const readiness   = deriveReadiness(score, flags);
  const summary     = buildSummary(artifact, platformData, score, flags, readiness);

  return { score, readiness, flags, summary };
}

// ── Completeness score ────────────────────────────────────────────────────────
function calculateCompleteness(artifact, pd, flags) {
  // If we have real processors, score from them
  const processors = pd.processors || [];
  if (processors.length > 0) {
    let totalWeight  = 0;
    let earnedWeight = 0;

    for (const p of processors) {
      const k = (p.type || '').toLowerCase();
      const { weight, earned } = scoreProcessor(k, p, pd);
      totalWeight  += weight;
      earnedWeight += earned;
    }

    const raw = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 80;

    // Small bonuses/penalties on top
    let adjusted = raw;
    if (pd.hasXslt)  adjusted = Math.min(100, adjusted + 3); // XSLT extraction = real value
    if (pd.hasJava)  adjusted -= 8;                          // Java stubs need dev work
    if (flags.some(f => f.type === 'UNMAPPED_CONNECTOR')) adjusted -= 10;
    if (pd._source === 'metadata_fallback') adjusted -= 15;  // Less confident without raw_xml

    return Math.max(10, Math.min(100, adjusted));
  }

  // Fallback: use pre-calculated score from extractor, adjusted by flags
  let score = pd.completenessScore || artifact.complexity_score || 70;
  if (flags.some(f => f.type === 'UNMAPPED_CONNECTOR')) score -= 15;
  if (flags.some(f => f.type === 'SCRIPTING_PRESERVED')) score -= 10;
  if (pd._source === 'metadata_fallback') score -= 10;
  return Math.max(10, Math.min(100, Math.round(score)));
}

function scoreProcessor(k, p, pd) {
  // Auto-mapped (full credit)
  if (k === 'xslt')            return { weight: 10, earned: 10 };
  if (k === 'contentmodifier') return { weight: 5,  earned: 5  };
  if (k === 'log')             return { weight: 3,  earned: 3  };
  if (k === 'router')          return { weight: 8,  earned: 7  };
  if (k === 'processcall')     return { weight: 8,  earned: 7  };
  if (k === 'splitter')        return { weight: 8,  earned: 7  };
  if (k === 'aggregator')      return { weight: 5,  earned: 4  };
  if (k === 'scope')           return { weight: 5,  earned: 4  };
  if (k === 'reply')           return { weight: 3,  earned: 3  };

  // Invoke — depends on connector type
  if (k === 'invoke') {
    const connType = (p.config && p.config.connType) || 'HTTP';
    if (UNMAPPED_CONNECTORS.has(connType)) return { weight: 10, earned: 0  };
    return { weight: 10, earned: 10 };
  }

  // Scripting — partial credit (stub generated)
  if (k === 'javascript' || k === 'transform-message' || k === 'transform' || k === 'ee:transform') {
    return { weight: 10, earned: 4 };
  }

  // RequestReply (receiver call)
  if (k === 'requestreply') {
    const connType = (p.config && p.config.connType) || 'HTTP';
    if (UNMAPPED_CONNECTORS.has(connType)) return { weight: 10, earned: 0 };
    return { weight: 10, earned: 10 };
  }

  // Unknown / generic
  return { weight: 5, earned: 3 };
}

// ── Flag generation ───────────────────────────────────────────────────────────
function buildConversionFlags(artifact, pd) {
  const flags = [];
  const platform   = (pd.platform || artifact.platform || '').toLowerCase();
  const processors = pd.processors || [];
  const connTypes  = pd.connectorTypes || [];

  // ── UNMAPPED_CONNECTOR ────────────────────────────────────────────────────
  for (const conn of connTypes) {
    if (UNMAPPED_CONNECTORS.has(conn)) {
      flags.push({
        type: 'UNMAPPED_CONNECTOR',
        severity: 'error',
        element: conn,
        suggestion: unmappedConnectorSuggestion(conn)
      });
    }
  }

  // Also check individual processors for unmapped invoke targets
  for (const p of processors) {
    if ((p.type || '').toLowerCase() === 'invoke') {
      const ct = p.config && p.config.connType;
      if (ct && UNMAPPED_CONNECTORS.has(ct) && !flags.some(f => f.element === ct)) {
        flags.push({
          type: 'UNMAPPED_CONNECTOR',
          severity: 'error',
          element: ct,
          suggestion: unmappedConnectorSuggestion(ct)
        });
      }
    }
  }

  // ── SCRIPTING_PRESERVED (MuleSoft DataWeave → Groovy stub) ───────────────
  if (platform.includes('mulesoft')) {
    const dwSteps = processors.filter(p => {
      const k = (p.type || '').toLowerCase();
      return k.includes('transform') || k === 'ee:transform';
    });
    if (dwSteps.length > 0) {
      flags.push({
        type: 'SCRIPTING_PRESERVED',
        severity: 'warning',
        element: `${dwSteps.length} DataWeave transform(s)`,
        suggestion: 'Groovy stubs generated with original DataWeave 1.0 preserved as comments. Developer must implement equivalent logic in Groovy.'
      });
    }
  }

  // ── SCRIPTING_PRESERVED (BW5 Java → Groovy stub) ─────────────────────────
  if (platform.includes('tibco-bw5') || (artifact.platform === 'tibco' && artifact.artifact_type === 'ProcessDef')) {
    const javaSteps = processors.filter(p => (p.type || '').toLowerCase() === 'javascript');
    if (javaSteps.length > 0 || (pd.javaScripts && pd.javaScripts.length > 0)) {
      const count = javaSteps.length || (pd.javaScripts || []).length;
      flags.push({
        type: 'SCRIPTING_PRESERVED',
        severity: 'warning',
        element: `${count} JavaCode activity(-ies)`,
        suggestion: 'Groovy stubs generated with original Java preserved as comments. Developer must re-implement logic in Groovy for SAP IS runtime.'
      });
    }
  }

  // ── MANUAL_XSLT (complex XSLT with custom functions) ─────────────────────
  if (pd.xsltTransforms && pd.xsltTransforms.length > 0) {
    const complexXslt = pd.xsltTransforms.filter(x =>
      x.content && (
        x.content.includes('extension-function') ||
        x.content.includes('saxon:') ||
        x.content.includes('xalan:') ||
        x.content.includes('java:') ||
        x.content.includes('xsl:import') ||
        x.content.includes('xsl:include')
      )
    );
    if (complexXslt.length > 0) {
      flags.push({
        type: 'MANUAL_XSLT',
        severity: 'warning',
        element: `${complexXslt.length} XSLT file(s) with extension functions or imports`,
        suggestion: 'XSLT uses Saxon/Xalan extension functions not supported in SAP IS. Replace with IS-compatible XSLT 1.0 or Groovy script.'
      });
    }
  }

  // ── SCATTER_GATHER ────────────────────────────────────────────────────────
  const hasScatterGather = processors.some(p => (p.type || '').toLowerCase() === 'scatter-gather');
  if (hasScatterGather) {
    flags.push({
      type: 'SCATTER_GATHER',
      severity: 'warning',
      element: 'scatter-gather',
      suggestion: 'Converted to IS Parallel Multicast. Test branch synchronisation and aggregation step in IS Integration Designer.'
    });
  }

  // ── MULTI_FLOW_SPLIT (APIKit) ─────────────────────────────────────────────
  const hasApiKit = processors.some(p => {
    const k = (p.type || '').toLowerCase();
    return k.includes('apikit') || k === 'router' && (p.label || '').toLowerCase().includes('api');
  });
  if (hasApiKit) {
    flags.push({
      type: 'MULTI_FLOW_SPLIT',
      severity: 'info',
      element: 'apikit:router',
      suggestion: 'APIKit router detected. Each HTTP operation should become a separate iFlow. Review generated process and split manually in IS.'
    });
  }

  // ── TRANSACTION_SCOPE ─────────────────────────────────────────────────────
  const hasTransaction = processors.some(p => (p.type || '').toLowerCase() === 'transactional');
  if (hasTransaction) {
    flags.push({
      type: 'TRANSACTION_SCOPE',
      severity: 'warning',
      element: 'transactional',
      suggestion: 'SAP IS has limited XA transaction support. Review transaction boundaries. Consider using idempotency patterns instead.'
    });
  }

  // ── BATCH_JOB ─────────────────────────────────────────────────────────────
  const hasBatch = processors.some(p => (p.type || '').toLowerCase().includes('batch'));
  if (hasBatch) {
    flags.push({
      type: 'BATCH_JOB',
      severity: 'warning',
      element: 'batch:job',
      suggestion: 'Batch job converted to Iterating Splitter pattern. Review chunk size and error handling in IS.'
    });
  }

  // ── SUBPROCESS_SPLIT (BW5 SubProcess calls) ───────────────────────────────
  const subprocessSteps = processors.filter(p => (p.type || '').toLowerCase() === 'processcall');
  if (subprocessSteps.length > 0) {
    flags.push({
      type: 'SUBPROCESS_SPLIT',
      severity: 'info',
      element: `${subprocessSteps.length} SubProcess call(s)`,
      suggestion: `${subprocessSteps.length} separate iFlow(s) needed for sub-process references. Create Process Direct iFlows for each.`
    });
  }

  // ── MISSING_RAW_XML ───────────────────────────────────────────────────────
  if (pd._source === 'metadata_fallback' || !artifact.raw_xml) {
    flags.push({
      type: 'MISSING_RAW_XML',
      severity: 'info',
      element: 'source XML',
      suggestion: 'Conversion based on metadata only — re-upload the source file to get real connector extraction and XSLT generation.'
    });
  }

  // ── LOW_COMPLETENESS ─────────────────────────────────────────────────────
  // (added after score is calculated by caller — kept out of this fn)

  return flags;
}

// ── Readiness derivation ──────────────────────────────────────────────────────
function deriveReadiness(score, flags) {
  const hasErrors   = flags.some(f => f.severity === 'error');
  const hasWarnings = flags.some(f => f.severity === 'warning');

  if (hasErrors || score < 60)              return 'Manual';
  if (hasWarnings || score < 85)            return 'Partial';
  return 'Auto';
}

// ── Summary block ─────────────────────────────────────────────────────────────
function buildSummary(artifact, pd, score, flags, readiness) {
  const processors  = pd.processors || [];
  const xsltCount   = (pd.xsltTransforms || []).length;
  const javaCount   = (pd.javaScripts    || []).length;
  const scriptCount = processors.filter(p => {
    const k = (p.type || '').toLowerCase();
    return k.includes('transform') || k === 'javascript' || k === 'ee:transform';
  }).length;

  const errorCount   = flags.filter(f => f.severity === 'error').length;
  const warningCount = flags.filter(f => f.severity === 'warning').length;
  const infoCount    = flags.filter(f => f.severity === 'info').length;

  const connTypes = pd.connectorTypes || [];
  const unmapped  = connTypes.filter(c => UNMAPPED_CONNECTORS.has(c));
  const mapped    = connTypes.filter(c => !UNMAPPED_CONNECTORS.has(c));

  return {
    completeness_pct:   score,
    readiness,
    steps_total:        processors.length,
    steps_auto:         processors.length - scriptCount,
    steps_scripting:    scriptCount,
    xslt_extracted:     xsltCount,
    java_stubs:         javaCount,
    connectors_mapped:  mapped,
    connectors_unmapped: unmapped,
    flags_error:        errorCount,
    flags_warning:      warningCount,
    flags_info:         infoCount,
    data_source:        pd._source || 'unknown',
    platform_detected:  pd.platform || artifact.platform
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function unmappedConnectorSuggestion(conn) {
  const map = {
    MongoDB:   'No native SAP IS adapter. Use HTTPS adapter with MongoDB Atlas REST API (https://data.mongodb-api.com/app/{app-id}/endpoint).',
    Kafka:     'No native SAP IS adapter. Use SAP Event Mesh or Confluent REST Proxy via HTTPS adapter.',
    S3:        'No native SAP IS adapter. Use HTTPS adapter with AWS S3 REST API (s3.amazonaws.com) + SigV4 auth header step.',
    AMQP:      'Use SAP IS AMQP adapter (available since IS Cloud Edition 2023).',
    LDAP:      'No native SAP IS adapter. Use HTTPS adapter with LDAP-over-HTTP proxy or OData service.',
    CMIS:      'No native SAP IS adapter. Use HTTPS adapter with CMIS AtomPub REST binding.',
    WMQ:       'Use SAP IS JMS adapter configured for IBM MQ (IBM MQ JMS provider).',
    RabbitMQ:  'Use SAP IS AMQP adapter with RabbitMQ AMQP endpoint.'
  };
  return map[conn] || `No native SAP IS adapter for ${conn}. Implement via HTTPS adapter with REST API.`;
}

module.exports = { runQualityAnalysis, buildConversionFlags, calculateCompleteness, deriveReadiness };
