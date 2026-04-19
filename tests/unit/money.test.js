'use strict';

const { describe, it, expect } = require('vitest');
const { toVND, fromVND, add, sub, gte, gt, isPositive, format, Decimal } = require('../../src/lib/money');

describe('money.js', () => {
  describe('toVND()', () => {
    it('parses string to Decimal', () => {
      const d = toVND('12345.67');
      expect(d).toBeInstanceOf(Decimal);
      expect(d.toFixed(2)).toBe('12345.67');
    });

    it('accepts Decimal passthrough', () => {
      const d = new Decimal('100.50');
      expect(toVND(d)).toBe(d);
    });

    it('rejects JS Number (prevents float bugs)', () => {
      expect(() => toVND(0.1)).toThrow(TypeError);
      expect(() => toVND(100)).toThrow(TypeError);
      expect(() => toVND(0)).toThrow(TypeError);
    });

    it('rejects invalid string', () => {
      expect(() => toVND('abc')).toThrow();
      expect(() => toVND('')).toThrow();
      expect(() => toVND('  ')).toThrow();
    });

    it('allows negative (sign check is caller job)', () => {
      const d = toVND('-100');
      expect(d.toFixed(2)).toBe('-100.00');
    });

    it('rejects non-string non-Decimal types', () => {
      expect(() => toVND(null)).toThrow(TypeError);
      expect(() => toVND(undefined)).toThrow(TypeError);
      expect(() => toVND({})).toThrow(TypeError);
    });
  });

  describe('fromVND()', () => {
    it('returns fixed-2 string', () => {
      expect(fromVND(new Decimal('123.456'))).toBe('123.46');
      expect(fromVND(new Decimal('100'))).toBe('100.00');
    });

    it('rejects non-Decimal', () => {
      expect(() => fromVND('100')).toThrow(TypeError);
    });
  });

  describe('add()', () => {
    it('0.1 + 0.2 === 0.30 (no float error)', () => {
      const result = add('0.1', '0.2');
      expect(result.toFixed(2)).toBe('0.30');
      expect(result.eq(new Decimal('0.3'))).toBe(true);
    });

    it('large number precision: 99999999.99 + 0.01 = 100000000.00', () => {
      const result = add('99999999.99', '0.01');
      expect(result.toFixed(2)).toBe('100000000.00');
    });

    it('adds two string values', () => {
      expect(add('500', '300').toFixed(2)).toBe('800.00');
    });

    it('adds Decimal + string', () => {
      expect(add(new Decimal('100'), '200').toFixed(2)).toBe('300.00');
    });
  });

  describe('sub()', () => {
    it('basic subtraction', () => {
      expect(sub('1000', '300').toFixed(2)).toBe('700.00');
    });

    it('result can be negative', () => {
      const result = sub('100.00', '100.01');
      expect(result.toFixed(2)).toBe('-0.01');
      expect(result.isNeg()).toBe(true);
    });
  });

  describe('gte()', () => {
    it('equal values → true', () => {
      expect(gte('100.00', '100.00')).toBe(true);
    });

    it('greater → true', () => {
      expect(gte('100.01', '100.00')).toBe(true);
    });

    it('less → false', () => {
      expect(gte('99.99', '100.00')).toBe(false);
    });
  });

  describe('gt()', () => {
    it('equal → false', () => {
      expect(gt('100', '100')).toBe(false);
    });

    it('greater → true', () => {
      expect(gt('100.01', '100')).toBe(true);
    });
  });

  describe('isPositive()', () => {
    it('positive → true', () => {
      expect(isPositive('1')).toBe(true);
      expect(isPositive('0.01')).toBe(true);
    });

    it('zero → false', () => {
      expect(isPositive('0')).toBe(false);
    });

    it('negative → false', () => {
      expect(isPositive('-1')).toBe(false);
    });
  });

  describe('format()', () => {
    it('formats with Vietnamese grouping (dots)', () => {
      expect(format(new Decimal('1234567.89'))).toBe('1.234.567 ₫');
    });

    it('formats zero', () => {
      expect(format(new Decimal('0'))).toBe('0 ₫');
    });

    it('formats small number', () => {
      expect(format(new Decimal('500'))).toBe('500 ₫');
    });

    it('formats negative', () => {
      expect(format(new Decimal('-50000'))).toBe('-50.000 ₫');
    });

    it('rejects non-Decimal', () => {
      expect(() => format('1000')).toThrow(TypeError);
    });

    it('formats large number', () => {
      expect(format(new Decimal('99999999999'))).toBe('99.999.999.999 ₫');
    });
  });
});
