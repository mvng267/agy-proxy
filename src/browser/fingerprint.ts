import { FingerprintGenerator, type BrowserFingerprintWithHeaders } from 'fingerprint-generator';
import { config } from '../config.js';
import { store } from '../store/index.js';
import type { Account } from '../store/models.js';

/**
 * Fingerprint riêng & CỐ ĐỊNH cho từng account, COHERENT với máy thật:
 * ép về macOS + Chrome desktop (khớp UA/OS/TLS thật của Mac Chrome — tránh
 * mismatch JA3/Client Hints). Vary canvas/WebGL/screen/cores/RAM/fonts giữa
 * các account để de-link. Sinh 1 lần, lưu vào accounts.csv, tái dùng y hệt.
 */

// Ép Chrome, macOS, desktop; pin version sát Chrome thật (host - 2 .. host).
const generator = new FingerprintGenerator({
  devices: ['desktop'],
  operatingSystems: ['macos'],
  browsers: [{ name: 'chrome', minVersion: Math.max(100, config.chromeMajor - 2), maxVersion: config.chromeMajor }],
});

export function getFingerprint(account: Account, locale?: string): BrowserFingerprintWithHeaders {
  if (account.fingerprint) {
    try {
      const fp = JSON.parse(account.fingerprint) as BrowserFingerprintWithHeaders;
      // Ép slim ngay cả với FP lưu từ trước (non-slim làm gaia báo "Something went wrong").
      fp.fingerprint.slim = true;
      return fp;
    } catch {
      /* hỏng -> sinh lại */
    }
  }
  const fp = generator.getFingerprint({
    locales: [locale || account.locale || 'en-US'],
    slim: true, // patch nhẹ hơn — trang login Google (gaia) không phát hiện injection
  });
  fp.fingerprint.slim = true;
  store.upsertAccount({ email: account.email, fingerprint: JSON.stringify(fp) });
  return fp;
}
