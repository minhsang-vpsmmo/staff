'use strict';

const express = require('express');
const { registerHandler } = require('./register');
const { loginHandler } = require('./login');
const { refreshHandler } = require('./refresh');
const { logoutHandler, logoutAllHandler } = require('./logout');
const { verifyEmailHandler } = require('./verify-email');
const { forgotPasswordHandler } = require('./forgot-password');
const { resetPasswordHandler } = require('./reset-password');
const { getMeHandler, updateMeHandler, changePasswordHandler } = require('./me');
const { requireAuth } = require('../../middleware/auth');
const { createRateLimit, presets } = require('../../middleware/rate-limit');

function createAuthRoutes(config) {
  const router = express.Router();

  // Public auth endpoints (rate limited)
  router.post('/auth/register', createRateLimit(presets.authRegister), registerHandler(config));
  router.post('/auth/login', createRateLimit(presets.authLogin), loginHandler(config));
  router.post('/auth/refresh', refreshHandler(config));
  router.post('/auth/logout', logoutHandler(config));
  router.get('/auth/verify-email', verifyEmailHandler(config));
  router.post('/auth/forgot-password',
    createRateLimit(presets.authForgot),
    createRateLimit(presets.authForgotEmail),
    forgotPasswordHandler(config)
  );
  router.post('/auth/reset-password', resetPasswordHandler(config));

  // Protected endpoints
  router.get('/me', requireAuth(config), getMeHandler(config));
  router.patch('/me', requireAuth(config), updateMeHandler(config));
  router.post('/me/change-password', requireAuth(config), changePasswordHandler(config));
  router.post('/me/logout-all', requireAuth(config), logoutAllHandler(config));

  return router;
}

module.exports = { createAuthRoutes };
