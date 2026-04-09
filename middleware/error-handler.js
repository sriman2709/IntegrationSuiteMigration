'use strict';
/**
 * Global error-handling middleware — RFC 7807 Problem Details format
 * All routes call next(err) — error handling lives here only.
 */

function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const detail = err.message || 'An unexpected error occurred';

  // Structured log
  console.error(JSON.stringify({
    level: 'error', timestamp: new Date().toISOString(),
    method: req.method, path: req.path,
    status, detail,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined
  }));

  // RFC 7807 Problem Details
  res.status(status).json({
    type:   `https://is-migration.sierradigital.com/errors/${err.code || 'internal-error'}`,
    title:  httpTitle(status),
    status,
    detail,
    instance: req.path
  });
}

function httpTitle(status) {
  const titles = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity', 500: 'Internal Server Error' };
  return titles[status] || 'Error';
}

// Convenience factory — creates an error with a status code
function createError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code   = code || 'error';
  return err;
}

module.exports = { errorHandler, createError };
