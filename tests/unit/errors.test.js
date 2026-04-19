'use strict';

const { describe, it, expect } = require('vitest');
const {
  AppError,
  ValidationError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  InsufficientBalanceError,
  RateLimitError,
} = require('../../src/lib/errors');

describe('errors.js', () => {
  it('AppError serializes to standard shape', () => {
    const err = new AppError('TEST_CODE', 'Test message', 418, { foo: 'bar' });
    const json = err.toJSON();
    expect(json).toEqual({
      error: {
        code: 'TEST_CODE',
        message: 'Test message',
        status: 418,
        details: { foo: 'bar' },
      },
    });
    expect(err.status).toBe(418);
    expect(err instanceof Error).toBe(true);
  });

  it('AppError without details omits details key', () => {
    const err = new AppError('NO_DETAIL', 'msg', 500);
    expect(err.toJSON().error.details).toBeUndefined();
  });

  it('ValidationError → 400', () => {
    const err = new ValidationError('Bad input', [{ field: 'email' }]);
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.toJSON().error.details).toEqual([{ field: 'email' }]);
  });

  it('AuthError → 401', () => {
    const err = new AuthError('Not logged in');
    expect(err.status).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('AuthError with custom code', () => {
    const err = new AuthError('Token expired', 'TOKEN_EXPIRED');
    expect(err.code).toBe('TOKEN_EXPIRED');
  });

  it('ForbiddenError → 403', () => {
    const err = new ForbiddenError();
    expect(err.status).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
  });

  it('NotFoundError → 404', () => {
    const err = new NotFoundError('User not found');
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('InsufficientBalanceError → 402 with details', () => {
    const err = new InsufficientBalanceError({ required: '89000', available: '50000' });
    expect(err.status).toBe(402);
    expect(err.code).toBe('INSUFFICIENT_BALANCE');
    expect(err.toJSON().error.details).toEqual({ required: '89000', available: '50000' });
  });

  it('RateLimitError → 429', () => {
    const err = new RateLimitError('2025-01-01T00:15:00Z');
    expect(err.status).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.toJSON().error.details.retry_after).toBe('2025-01-01T00:15:00Z');
  });

  it('all errors have stack traces', () => {
    const errors = [
      new AppError('A', 'a'), new ValidationError(), new AuthError(),
      new ForbiddenError(), new NotFoundError(), new InsufficientBalanceError(),
      new RateLimitError(),
    ];
    for (const err of errors) {
      expect(err.stack).toBeDefined();
      expect(err.stack).toContain('errors.test.js');
    }
  });
});
