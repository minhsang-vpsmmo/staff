-- ============================================================
-- Migration 001: Initial Schema
-- VPSMMO Monitoring — 22 tables (21 app + 1 tracking)
-- Idempotent: uses IF NOT EXISTS throughout
-- ============================================================

-- ── Order 1: No FK dependencies ──

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(190) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  balance DECIMAL(15,2) NOT NULL DEFAULT 0,
  telegram_chat_id VARCHAR(50) NULL,
  telegram_verified BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  email_verify_token VARCHAR(100) NULL,
  role ENUM('user','admin','superadmin') NOT NULL DEFAULT 'user',
  status ENUM('active','suspended','banned') NOT NULL DEFAULT 'active',
  failed_login_count INT NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  last_login_at DATETIME NULL,
  last_login_ip VARCHAR(45) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS service_plans (
  id INT PRIMARY KEY AUTO_INCREMENT,
  slug VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  monitor_slots INT NOT NULL,
  min_check_interval_sec INT NOT NULL DEFAULT 300,
  price_monthly DECIMAL(15,2) NOT NULL,
  price_yearly DECIMAL(15,2) NOT NULL,
  features JSON NOT NULL COMMENT 'telegram,email,webhook,sms,api,statuspage',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pay2s_webhooks (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  pay2s_id VARCHAR(100) NULL COMMENT 'Pay2S id field',
  checksum VARCHAR(150) UNIQUE NOT NULL COMMENT 'idempotency key',
  gateway VARCHAR(50),
  account_number VARCHAR(50),
  transaction_number VARCHAR(100),
  transaction_date DATETIME,
  transfer_type ENUM('IN','OUT'),
  transfer_amount DECIMAL(15,2),
  content TEXT,
  raw_payload JSON NOT NULL,
  matched_user_id BIGINT UNSIGNED NULL,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  processing_error TEXT NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME NULL,
  INDEX idx_processed (processed, received_at),
  INDEX idx_user (matched_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  id VARCHAR(100) PRIMARY KEY COMMENT 'ip:action or userid:action',
  count INT NOT NULL DEFAULT 0,
  window_start DATETIME NOT NULL,
  locked_until DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS invoice_counter (
  month_key VARCHAR(7) PRIMARY KEY COMMENT 'YYYY-MM',
  counter INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS email_queue (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  to_email VARCHAR(190) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  html_body MEDIUMTEXT,
  text_body TEXT,
  attachments JSON NULL COMMENT '[{filename,path}]',
  category VARCHAR(50) NOT NULL COMMENT 'verify|reset|topup|invoice|alert|renewal',
  priority TINYINT NOT NULL DEFAULT 5 COMMENT '1=high, 10=low',
  status ENUM('pending','sending','sent','failed','cancelled') NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  scheduled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_status_sched (status, scheduled_at, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Order 2: FK → users ──

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  type ENUM('topup','purchase','renewal','refund','bonus','admin_adjust') NOT NULL,
  amount DECIMAL(15,2) NOT NULL COMMENT '+credit, -debit',
  balance_before DECIMAL(15,2) NOT NULL,
  balance_after DECIMAL(15,2) NOT NULL,
  ref_type VARCHAR(50) NULL COMMENT 'pay2s|subscription|admin|referral',
  ref_id VARCHAR(100) NULL,
  idempotency_key VARCHAR(150) UNIQUE NULL,
  description TEXT NULL,
  admin_id BIGINT UNSIGNED NULL COMMENT 'if admin_adjust',
  admin_reason TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_time (user_id, created_at DESC),
  INDEX idx_ref (ref_type, ref_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS unmatched_payments (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  webhook_id BIGINT UNSIGNED NOT NULL,
  transfer_amount DECIMAL(15,2) NOT NULL,
  content TEXT,
  status ENUM('pending','resolved','refunded') NOT NULL DEFAULT 'pending',
  resolved_by_admin_id BIGINT UNSIGNED NULL,
  resolved_to_user_id BIGINT UNSIGNED NULL,
  resolved_at DATETIME NULL,
  admin_note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (webhook_id) REFERENCES pay2s_webhooks(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_sessions (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  refresh_token_hash VARCHAR(255) UNIQUE NOT NULL,
  ip_address VARCHAR(45),
  user_agent VARCHAR(500),
  expires_at DATETIME NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_expires (expires_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  admin_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(100) NOT NULL COMMENT 'balance_adjust|login_as|user_ban|plan_update',
  target_type VARCHAR(50) NULL,
  target_id BIGINT UNSIGNED NULL,
  reason TEXT,
  metadata JSON,
  ip_address VARCHAR(45),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_time (admin_id, created_at DESC),
  INDEX idx_target (target_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_tokens (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  monitor_id BIGINT UNSIGNED NULL COMMENT 'nullable if token scoped to user',
  token_hash VARCHAR(255) UNIQUE NOT NULL COMMENT 'bcrypt of token',
  label VARCHAR(100) NULL,
  last_used_at DATETIME NULL,
  last_used_ip VARCHAR(45) NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id, revoked),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash VARCHAR(255) UNIQUE NOT NULL COMMENT 'sha256 of token',
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  requested_ip VARCHAR(45),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_expires (expires_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS telegram_verification_codes (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(10) NOT NULL COMMENT '6-digit',
  telegram_chat_id VARCHAR(50) NOT NULL,
  expires_at DATETIME NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_expires (expires_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS discount_codes (
  id INT PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(50) UNIQUE NOT NULL,
  description VARCHAR(200),
  type ENUM('percent','fixed') NOT NULL,
  value DECIMAL(15,2) NOT NULL COMMENT 'percent: 0-100; fixed: VND',
  min_purchase DECIMAL(15,2) NOT NULL DEFAULT 0,
  max_discount DECIMAL(15,2) NULL COMMENT 'cap for percent type',
  applicable_to ENUM('all','purchase','renewal','upgrade') NOT NULL DEFAULT 'all',
  applicable_plan_ids JSON NULL COMMENT 'null=all, [1,3,5]=only these',
  usage_limit INT NULL COMMENT 'total uses, null=unlimited',
  usage_limit_per_user INT NOT NULL DEFAULT 1,
  used_count INT NOT NULL DEFAULT 0,
  valid_from DATETIME NOT NULL,
  valid_until DATETIME NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_admin_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_code_active (code, is_active),
  INDEX idx_validity (valid_from, valid_until),
  FOREIGN KEY (created_by_admin_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Order 3: FK → users + service_plans ──

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  plan_id INT NOT NULL,
  status ENUM('active','grace','suspended','cancelled','expired') NOT NULL DEFAULT 'active',
  billing_cycle ENUM('monthly','yearly') NOT NULL DEFAULT 'monthly',
  current_period_start DATETIME NOT NULL,
  current_period_end DATETIME NOT NULL,
  grace_period_end DATETIME NULL,
  auto_renew BOOLEAN NOT NULL DEFAULT TRUE,
  cancelled_at DATETIME NULL,
  cancel_reason TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_renewal (status, auto_renew, current_period_end),
  INDEX idx_user_status (user_id, status),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (plan_id) REFERENCES service_plans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Order 4: FK → users + user_subscriptions + wallet_transactions ──

CREATE TABLE IF NOT EXISTS invoices (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  invoice_number VARCHAR(50) UNIQUE NOT NULL COMMENT 'INV-YYYYMM-NNNNNN',
  user_id BIGINT UNSIGNED NOT NULL,
  subscription_id BIGINT UNSIGNED NULL,
  wallet_transaction_id BIGINT UNSIGNED NULL COMMENT 'linked debit txn',
  type ENUM('purchase','renewal','upgrade','downgrade') NOT NULL,
  plan_id INT NULL,
  plan_name_snapshot VARCHAR(100) NOT NULL COMMENT 'plan name at time of sale',
  billing_cycle ENUM('monthly','yearly') NOT NULL,
  subtotal DECIMAL(15,2) NOT NULL,
  discount_code VARCHAR(50) NULL,
  discount_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  total DECIMAL(15,2) NOT NULL,
  status ENUM('paid','cancelled','refunded') NOT NULL DEFAULT 'paid',
  billing_name VARCHAR(200) NULL COMMENT 'company or person name',
  billing_tax_id VARCHAR(50) NULL COMMENT 'MST Vietnam',
  billing_address TEXT NULL,
  billing_email VARCHAR(190) NULL,
  notes TEXT NULL,
  pdf_path VARCHAR(500) NULL,
  issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_time (user_id, issued_at DESC),
  INDEX idx_number (invoice_number),
  INDEX idx_subscription (subscription_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (subscription_id) REFERENCES user_subscriptions(id),
  FOREIGN KEY (wallet_transaction_id) REFERENCES wallet_transactions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS monitors (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  subscription_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  type ENUM('http','https','ping','tcp','keyword','ssl','dns') NOT NULL,
  target VARCHAR(500) NOT NULL,
  port INT NULL,
  keyword VARCHAR(200) NULL,
  check_interval_sec INT NOT NULL DEFAULT 300,
  timeout_sec INT NOT NULL DEFAULT 30,
  status ENUM('up','down','paused','unknown') NOT NULL DEFAULT 'unknown',
  last_check_at DATETIME NULL,
  last_status_change_at DATETIME NULL,
  is_paused BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'paused by user or by expiry',
  pause_reason ENUM('user','subscription_expired','admin') NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_check (is_paused, check_interval_sec, last_check_at),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (subscription_id) REFERENCES user_subscriptions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Order 5: FK → monitors ──

CREATE TABLE IF NOT EXISTS monitor_checks (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  monitor_id BIGINT UNSIGNED NOT NULL,
  status ENUM('up','down') NOT NULL,
  response_time_ms INT NULL,
  status_code INT NULL,
  error_message TEXT NULL,
  checked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_monitor_time (monitor_id, checked_at DESC),
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS monitor_alerts (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  monitor_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  alert_type ENUM('down','up','ssl_expiry') NOT NULL,
  channel ENUM('telegram','email','webhook') NOT NULL,
  target VARCHAR(500) NOT NULL,
  message TEXT,
  delivery_status ENUM('sent','failed','rate_limited') NOT NULL,
  error_message TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_monitor_time (monitor_id, created_at DESC),
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS monitor_notification_prefs (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  monitor_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  telegram_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  webhook_url VARCHAR(500) NULL,
  webhook_secret VARCHAR(100) NULL COMMENT 'HMAC secret for webhook verification',
  alert_down_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  alert_up_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  alert_ssl_expiry_days INT NULL DEFAULT 7 COMMENT 'alert N days before cert expires',
  mute_until DATETIME NULL COMMENT 'maintenance window',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_monitor (monitor_id),
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Order 6: FK → discount_codes + users + invoices ──

CREATE TABLE IF NOT EXISTS discount_code_usages (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  discount_code_id INT NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  invoice_id BIGINT UNSIGNED NOT NULL,
  discount_amount DECIMAL(15,2) NOT NULL,
  used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_code (user_id, discount_code_id),
  UNIQUE KEY uniq_invoice (invoice_id) COMMENT 'one discount per invoice',
  FOREIGN KEY (discount_code_id) REFERENCES discount_codes(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (invoice_id) REFERENCES invoices(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- Seed data: default service plans
-- ============================================================

INSERT IGNORE INTO service_plans (slug, name, description, monitor_slots, min_check_interval_sec,
                                  price_monthly, price_yearly, features, display_order) VALUES
('starter', 'Starter', 'Cho cá nhân, website đơn giản', 1, 300,
 29000, 290000, '["telegram","email"]', 10),
('pro', 'Pro', 'Cho dev/team nhỏ, theo dõi nhiều site', 5, 60,
 89000, 890000, '["telegram","email","webhook","ssl"]', 20),
('business', 'Business', 'Doanh nghiệp, monitor toàn hệ thống', 20, 30,
 249000, 2490000, '["telegram","email","webhook","ssl","api","statuspage"]', 30),
('agency', 'Agency', 'Agency, MSP quản lý khách hàng', 100, 30,
 699000, 6990000, '["telegram","email","webhook","ssl","api","statuspage","priority"]', 40);
