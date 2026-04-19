'use strict';

const Decimal = require('decimal.js');

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

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

function fromVND(dec) {
  if (!(dec instanceof Decimal)) {
    throw new TypeError('money.fromVND() expects Decimal instance');
  }
  return dec.toFixed(2);
}

function add(a, b) {
  return toVND(a).plus(toVND(b));
}

function sub(a, b) {
  return toVND(a).minus(toVND(b));
}

function gte(a, b) {
  return toVND(a).gte(toVND(b));
}

function gt(a, b) {
  return toVND(a).gt(toVND(b));
}

function isPositive(value) {
  return toVND(value).gt(0);
}

/**
 * Format Decimal as Vietnamese currency. Truncates decimals (floor).
 * 1234567.89 → "1.234.567 ₫"
 */
function format(dec) {
  if (!(dec instanceof Decimal)) {
    throw new TypeError('money.format() expects Decimal instance');
  }
  // Floor to integer (truncate, don't round up) for display
  const floored = dec.toDecimalPlaces(0, Decimal.ROUND_FLOOR);
  const fixed = floored.toFixed(0);
  const isNeg = fixed.startsWith('-');
  const abs = isNeg ? fixed.slice(1) : fixed;
  const formatted = abs.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${isNeg ? '-' : ''}${formatted} ₫`;
}

module.exports = { toVND, fromVND, add, sub, gte, gt, isPositive, format, Decimal };
