'use strict';

const jwt = require('jsonwebtoken');
const { issueAccess, verifyAccess, parseTtlToSeconds } = require('../../src/lib/jwt');
const { AuthError } = require('../../src/lib/errors');

const TEST_CONFIG = {
  JWT_ACCESS_SECRET: 'test-access-secret-that-is-at-least-32-chars',
  JWT_REFRESH_SECRET: 'test-refresh-secret-that-is-at-least-32-chars',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '30d',
};

describe('jwt.js', () => {
  describe('issueAccess()', () => {
    it('returns a valid JWT string', () => {
      const token = issueAccess({ id: 1, role: 'user' }, TEST_CONFIG);
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('payload contains only sub and role', () => {
      const token = issueAccess({ id: 42, role: 'admin', email: 'x@test.com', balance: 99999 }, TEST_CONFIG);
      const decoded = jwt.decode(token);
      expect(decoded.sub).toBe(42);
      expect(decoded.role).toBe('admin');
      expect(decoded.email).toBeUndefined();
      expect(decoded.balance).toBeUndefined();
      expect(decoded.password).toBeUndefined();
    });

    it('uses HS256 algorithm', () => {
      const token = issueAccess({ id: 1, role: 'user' }, TEST_CONFIG);
      const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
      expect(header.alg).toBe('HS256');
    });
  });

  describe('verifyAccess()', () => {
    it('verifies valid token', () => {
      const token = issueAccess({ id: 5, role: 'user' }, TEST_CONFIG);
      const payload = verifyAccess(token, TEST_CONFIG);
      expect(payload.sub).toBe(5);
      expect(payload.role).toBe('user');
    });

    it('rejects alg:none forged token (ATK-A01)', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: 1, role: 'superadmin', iat: Math.floor(Date.now()/1000), exp: 9999999999 })).toString('base64url');
      const forgedToken = `${header}.${payload}.`;

      expect(() => verifyAccess(forgedToken, TEST_CONFIG)).toThrow(AuthError);
    });

    it('rejects token signed with wrong secret', () => {
      const token = jwt.sign({ sub: 1, role: 'user' }, 'wrong-secret', { algorithm: 'HS256' });
      expect(() => verifyAccess(token, TEST_CONFIG)).toThrow(AuthError);
    });

    it('throws TOKEN_EXPIRED for expired token', () => {
      const token = jwt.sign({ sub: 1, role: 'user' }, TEST_CONFIG.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '0s' });
      try {
        verifyAccess(token, TEST_CONFIG);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect(err.code).toBe('TOKEN_EXPIRED');
      }
    });

    it('rejects RS256 token (ATK-A02 — algorithm confusion)', () => {
      // Token signed with HS256 using a different key won't verify
      const token = jwt.sign({ sub: 1, role: 'admin' }, 'attacker-key', { algorithm: 'HS256' });
      expect(() => verifyAccess(token, TEST_CONFIG)).toThrow(AuthError);
    });
  });

  describe('parseTtlToSeconds()', () => {
    it('parses minutes', () => expect(parseTtlToSeconds('15m')).toBe(900));
    it('parses hours', () => expect(parseTtlToSeconds('1h')).toBe(3600));
    it('parses days', () => expect(parseTtlToSeconds('30d')).toBe(2592000));
    it('parses seconds', () => expect(parseTtlToSeconds('60s')).toBe(60));
    it('defaults to 30d for invalid', () => expect(parseTtlToSeconds('invalid')).toBe(2592000));
  });
});
