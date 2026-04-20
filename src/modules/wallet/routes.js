'use strict';

const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { getBalance, getTransactions } = require('./service');
const { transactionsQuerySchema } = require('./validators');
const { generateTopupInfo } = require('../../lib/vietqr');
const logger = require('../../lib/logger');

const log = logger.child({ module: 'wallet.routes' });

function createWalletRoutes(config) {
  const router = express.Router();
  const auth = requireAuth(config);

  // GET /api/wallet/balance — ownership via req.user.id
  router.get('/wallet/balance', auth, async (req, res, next) => {
    try {
      const result = await getBalance(req.user.id);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wallet/transactions — ownership via req.user.id
  router.get('/wallet/transactions', auth, async (req, res, next) => {
    try {
      const filters = transactionsQuerySchema.parse(req.query);
      const result = await getTransactions(req.user.id, {
        page: filters.page,
        perPage: filters.per_page,
        type: filters.type,
        from: filters.from,
        to: filters.to,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/wallet/topup-info — bank accounts + QR + memo
  router.get('/wallet/topup-info', auth, async (req, res, next) => {
    try {
      const info = generateTopupInfo(req.user.id, config);
      res.json({ data: info });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createWalletRoutes };
