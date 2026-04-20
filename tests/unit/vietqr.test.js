'use strict';

const { generateTopupInfo, buildQrUrl } = require('../../src/lib/vietqr');

describe('vietqr.js', () => {
  it('generates QR URL with correct format', () => {
    const url = buildQrUrl('ACB', '12805521', 'VPSMMO42');
    expect(url).toContain('img.vietqr.io');
    expect(url).toContain('ACB-12805521-compact.png');
    expect(url).toContain('addInfo=VPSMMO42');
    expect(url).toContain('accountName=VPSMMO');
  });

  it('generateTopupInfo returns correct structure', () => {
    const config = { PAY2S_BANK_ACCOUNTS: '12805521,737478888' };
    const info = generateTopupInfo(42, config);
    expect(info.user_id).toBe(42);
    expect(info.memo).toBe('VPSMMO42');
    expect(info.bank_accounts).toHaveLength(2);
    expect(info.bank_accounts[0].bank).toBe('ACB');
    expect(info.bank_accounts[0].account_number).toBe('12805521');
    expect(info.bank_accounts[0].qr_url).toContain('VPSMMO42');
    expect(info.bank_accounts[1].bank).toBe('MB');
  });

  it('handles empty PAY2S_BANK_ACCOUNTS gracefully', () => {
    const info = generateTopupInfo(1, { PAY2S_BANK_ACCOUNTS: '' });
    expect(info.bank_accounts).toHaveLength(0);
    expect(info.memo).toBe('VPSMMO1');
  });

  it('memo format is VPSMMO{userId}', () => {
    expect(generateTopupInfo(123, { PAY2S_BANK_ACCOUNTS: '' }).memo).toBe('VPSMMO123');
    expect(generateTopupInfo(1, { PAY2S_BANK_ACCOUNTS: '' }).memo).toBe('VPSMMO1');
    expect(generateTopupInfo(999999, { PAY2S_BANK_ACCOUNTS: '' }).memo).toBe('VPSMMO999999');
  });
});
