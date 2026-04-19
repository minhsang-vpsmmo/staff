'use strict';

const { z } = require('zod');
const commonPasswords = require('../../config/common-passwords');

const emailSchema = z.string().email('Invalid email').max(190).transform(v => v.toLowerCase().trim());

const passwordSchema = z.string()
  .min(8, 'Password must be at least 8 characters')
  .refine(
    (val) => Buffer.byteLength(val, 'utf8') <= 72,
    'Password exceeds 72-byte bcrypt limit'
  )
  .refine(
    (val) => !commonPasswords.includes(val.toLowerCase()),
    'Password is too common'
  );

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
}).strict();

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password required'),
}).strict();

const forgotPasswordSchema = z.object({
  email: emailSchema,
}).strict();

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token required'),
  new_password: passwordSchema,
}).strict();

const changePasswordSchema = z.object({
  current_password: z.string().min(1, 'Current password required'),
  new_password: passwordSchema,
}).strict();

const updateProfileSchema = z.object({
  // Role, balance, email NOT allowed here (SEC-D05, ATK-A07)
}).strict();

function passwordStrength(password) {
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[a-z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  if (score <= 2) return 'weak';
  if (score <= 4) return 'medium';
  return 'strong';
}

module.exports = {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  updateProfileSchema,
  passwordStrength,
};
