/**
 * Connector Factory
 * Returns the correct platform connector. Each connector supports mock (default)
 * and real modes. Real mode activates automatically when platform credentials
 * are present in environment variables. Mock mode requires zero config.
 *
 * Swap pattern: set env vars → connector auto-upgrades to real API.
 * No code changes required when real platform access is available.
 */

const BoomiConnector    = require('./boomi');
const MuleSoftConnector = require('./mulesoft');
const PIPOConnector     = require('./pipo');
const TIBCOConnector    = require('./tibco');

function getConnector(platform) {
  switch ((platform || '').toLowerCase()) {
    case 'boomi':    return new BoomiConnector();
    case 'mulesoft': return new MuleSoftConnector();
    case 'pipo':     return new PIPOConnector();
    case 'tibco':    return new TIBCOConnector();
    default:         return new BoomiConnector(); // safe default
  }
}

module.exports = { getConnector };
