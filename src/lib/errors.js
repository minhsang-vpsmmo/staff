'use strict';

/**
 * Base application error. All custom errors extend this.
 * Serializes to: { error: { code, message, status, details } }
 */
class AppError extends Error {
  constructor(code, message, status = 500, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.status ? { status: this.status } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed', details = null) {
    super('VALIDATION_FAILED', message, 400, details);
    this.name = 'ValidationError';
  }
}

class AuthError extends AppError {
  constructor(message = 'Unauthorized', code = 'UNAUTHORIZED') {
    super(code, message, 401);
    this.name = 'AuthError';
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super('FORBIDDEN', message, 403);
    this.name = 'ForbiddenError';
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super('NOT_FOUND', message, 404);
    this.name = 'NotFoundError';
  }
}

class InsufficientBalanceError extends AppError {
  constructor(details = {}) {
    super(
      'INSUFFICIENT_BALANCE',
      'Số dư không đủ để thực hiện giao dịch',
      402,
      details
    );
    this.name = 'InsufficientBalanceError';
  }
}

class RateLimitError extends AppError {
  constructor(retryAfter = null) {
    super('RATE_LIMITED', 'Too many requests', 429, retryAfter ? { retry_after: retryAfter } : null);
    this.name = 'RateLimitError';
  }
}

module.exports = {
  AppError,
  ValidationError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  InsufficientBalanceError,
  RateLimitError,
};
