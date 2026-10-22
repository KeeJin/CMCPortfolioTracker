import { describe, expect, test } from '@jest/globals';
import { isAllowedEmail, normalizeEmail } from '../src/auth.js';

describe('auth allowlist checks', () => {
  test('normalizes emails to lowercase for comparison', () => {
    expect(normalizeEmail('User@Example.com')).toBe('user@example.com');
  });

  test('accepts the configured email only', () => {
    expect(isAllowedEmail('user@example.com', 'user@example.com')).toBe(true);
    expect(isAllowedEmail('other@example.com', 'user@example.com')).toBe(false);
    expect(isAllowedEmail(undefined, 'user@example.com')).toBe(false);
  });
});
