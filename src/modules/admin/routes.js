'use strict';

const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { createRateLimit } = require('../../middleware/rate-limit');
const { balanceAdjustHandler } = require('./balance-adjust');

function createAdminRoutes(config) {
  const router = express.Router();
  const admin = requireAdmin(config);

  // Admin balance adjust with dedicated rate limit (10/hour/admin)
  const adjustRateLimit = createRateLimit({
    max: 10,
    windowMin: 60,
    keyFn: (req) => `admin_adjust:${req.user?.id}`,
  });

  router.post('/admin/users/:id/balance-adjust', admin, adjustRateLimit, balanceAdjustHandler(config));

  return router;
}

module.exports = { createAdminRoutes };
