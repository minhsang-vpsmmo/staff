'use strict';

const Decimal = require('decimal.js');

// Configure Decimal for financial precision
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

/**
 * Parse a value to Decimal. Rejects JS Number type to prevent float errors.
 * @param {string|Decimal} value
 * @returns {Decimal}
 */
function toVND(value) {
  if (typeof value === 'number') {
    throw new TypeError('money.toVND() does not accept JS Number. Use string or Decimal.');
  }
  if (value instanceof Decimal) return value;
  if (typeof value !== 'string') {
    throw new TypeError(`money.toVND() expects string or Decimal, got ${typeof value}`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === '') {
    throw new Error('money.toVND() received empty string');
  }
  try {
    return new Decimal(trimmed);
  } catch {
    throw new Error(`money.toVND() invalid value: "${trimmed}"`);
  }
}

/**
 * Convert Decimal to fixed-2 string for DB storage.
 * @param {Decimal} dec
 * @returns {string}
 */
function fromVND(dec) {
  if (!(dec instanceof Decimal)) {
    throw new TypeError('money.fromVND() expects Decimal instance');
  }
  return dec.toFixed(2);
}

/**
 * Add two money values. Returns Decimal.
 * @param {string|Decimal} a
 * @param {string|Decimal} b
 * @returns {Decimal}
 */
function add(a, b) {
  return toVND(a).plus(toVND(b));
}

/**
 * Subtract b from a. Returns Decimal (may be negative).
 * @param {string|Decimal} a
 * @param {string|Decimal} b
 * @returns {Decimal}
 */
function sub(a, b) {
  return toVND(a).minus(toVND(b));
}

/**
 * a >= b
 * @param {string|Decimal} a
 * @param {string|Decimal} b
 * @returns {boolean}
 */
function gte(a, b) {
  return toVND(a).gte(toVND(b));
}

/**
 * a > b
 * @param {string|Decimal} a
 * @param {string|Decimal} b
 * @returns {boolean}
 */
function gt(a, b) {
  return toVND(a).gt(toVND(b));
}

/**
 * Check if value is positive (> 0).
 * @param {string|Decimal} value
 * @returns {boolean}
 */
function isPositive(value) {
  return toVND(value).gt(0);
}

/**
 * Format Decimal as Vietnamese currency string.
 * E.g., 1234567.89 → "1.234.567 ₫"
 * @param {Decimal} dec
 * @returns {string}
 */
function format(dec) {
  if (!(dec instanceof Decimal)) {
    throw new TypeError('money.format() expects Decimal instance');
  }
  const fixed = dec.toFixed(0);
  const isNeg = fixed.startsWith('-');
  const abs = isNeg ? fixed.slice(1) : fixed;
  const formatted = abs.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${isNeg ? '-' : ''}${formatted} ₫`;
}

module.exports = { toVND, fromVND, add, sub, gte, gt, isPositive, format, Decimal };
