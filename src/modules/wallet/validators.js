'use strict';

const { z } = require('zod');
const { PAGINATION_MAX } = require('../../config/constants');

const transactionsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  per_page: z.coerce.number().int().min(1).max(PAGINATION_MAX).optional().default(20),
  type: z.enum(['topup', 'purchase', 'renewal', 'refund', 'bonus', 'admin_adjust']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
}).strict();

const balanceAdjustSchema = z.object({
  amount: z.string().min(1, 'Amount required').refine(
    (v) => { try { const n = parseFloat(v); return !isNaN(n) && n !== 0; } catch { return false; } },
    'Amount must be a non-zero number'
  ),
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
}).strict();

module.exports = { transactionsQuerySchema, balanceAdjustSchema };
