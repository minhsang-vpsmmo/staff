'use strict';

const { ZodError } = require('zod');
const { AppError } = require('../lib/errors');
const logger = require('../lib/logger');

const log = logger.child({ module: 'error-handler' });

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  // Zod validation errors → 400
  if (err instanceof ZodError) {
    const details = err.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
      code: e.code,
    }));
    return res.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Input validation failed',
        details,
      },
    });
  }

  // Known application errors → proper status
  if (err instanceof AppError) {
    if (err.status >= 500) {
      log.error({
        event: 'server.error',
        err: err.message,
        stack: err.stack,
        code: err.code,
        path: req.path,
        method: req.method,
        userId: req.user?.id,
      });
    }
    return res.status(err.status).json(err.toJSON());
  }

  // Unknown errors → 500, log full stack
  log.error({
    event: 'server.unhandled_error',
    err: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId: req.user?.id,
  });

  const isProd = process.env.NODE_ENV === 'production';
  return res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: isProd ? 'Internal server error' : err.message,
      ...(isProd ? {} : { stack: err.stack }),
    },
  });
}

module.exports = { errorHandler };
