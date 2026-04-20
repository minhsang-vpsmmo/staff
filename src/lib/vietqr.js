'use strict';

const { VIETQR_BASE_URL } = require('../config/constants');

const BANK_CODES = {
  // Map: account_number prefix or known bank → VietQR bank shortName
  'ACB': 'ACB',
  'VCB': 'VCB',
  'MB': 'MB',
  'TCB': 'TCB',
  'VPB': 'VPB',
  'BIDV': 'BIDV',
  'VTB': 'ICB', // VietinBank
  'TPB': 'TPB', // TPBank
  'STB': 'STB', // Sacombank
};

// Detect bank from account number patterns (simplified)
const ACCOUNT_BANK_MAP = {
  '12805521': 'ACB',
  '737478888': 'MB',
};

/**
 * Generate top-up info: bank accounts + VietQR URLs + memo format.
 * @param {number} userId
 * @param {Object} config — needs PAY2S_BANK_ACCOUNTS env
 * @returns {{ user_id, memo, bank_accounts: Array<{bank, account_number, qr_url}> }}
 */
function generateTopupInfo(userId, config) {
  const memo = `VPSMMO${userId}`;
  const accountsStr = config.PAY2S_BANK_ACCOUNTS || '';
  const accounts = accountsStr.split(',').map(a => a.trim()).filter(Boolean);

  const bankAccounts = accounts.map((accountNumber) => {
    const bankCode = ACCOUNT_BANK_MAP[accountNumber] || 'ACB';
    const qrUrl = buildQrUrl(bankCode, accountNumber, memo);
    return {
      bank: bankCode,
      account_number: accountNumber,
      qr_url: qrUrl,
    };
  });

  return {
    user_id: userId,
    memo,
    bank_accounts: bankAccounts,
    instructions: `Chuyển khoản với nội dung: ${memo}`,
  };
}

/**
 * Build VietQR image URL.
 * @param {string} bankCode — ACB, MB, VCB, etc.
 * @param {string} accountNumber
 * @param {string} memo — addInfo field
 * @returns {string} image URL
 */
function buildQrUrl(bankCode, accountNumber, memo) {
  const params = new URLSearchParams({
    amount: '0',
    addInfo: memo,
    accountName: 'VPSMMO',
  });
  return `${VIETQR_BASE_URL}/${bankCode}-${accountNumber}-compact.png?${params.toString()}`;
}

module.exports = { generateTopupInfo, buildQrUrl, ACCOUNT_BANK_MAP };
