import { describe, expect, it } from 'vitest';
import { sanitizeForLog } from '../src/logger/logger';

describe('sanitizeForLog', () => {
  it('redacts secret-looking keys', () => {
    const input = {
      user: 'alice',
      token: 'abc123',
      api_key: 'secret',
      headers: { Authorization: 'Bearer xyz' },
      nested: { password: 'hunter2', safe: 'ok' },
    };
    const out = sanitizeForLog(input) as Record<string, unknown>;
    expect(out.user).toBe('alice');
    expect(out.token).toBe('[REDACTED]');
    expect(out.api_key).toBe('[REDACTED]');
    const headers = out.headers as Record<string, unknown>;
    expect(headers.Authorization).toBe('[REDACTED]');
    const nested = out.nested as Record<string, unknown>;
    expect(nested.password).toBe('[REDACTED]');
    expect(nested.safe).toBe('ok');
  });

  it('passes through primitives and null', () => {
    expect(sanitizeForLog(null)).toBeNull();
    expect(sanitizeForLog(undefined)).toBeUndefined();
    expect(sanitizeForLog(42)).toBe(42);
    expect(sanitizeForLog('hello')).toBe('hello');
  });

  it('sanitises arrays element-by-element', () => {
    const out = sanitizeForLog([{ token: 'a' }, { ok: 1 }]) as unknown[];
    expect((out[0] as Record<string, unknown>).token).toBe('[REDACTED]');
    expect((out[1] as Record<string, unknown>).ok).toBe(1);
  });
});
