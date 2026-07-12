import { describe, expect, it } from 'vitest';
import { satisfies } from '../src/utils/semver';

describe('semver satisfies', () => {
  it('handles wildcards', () => {
    expect(satisfies('1.2.3', '*')).toBe(true);
    expect(satisfies('9.9.9', 'x')).toBe(true);
    expect(satisfies('1.0.0', '')).toBe(true);
  });

  it('handles caret ranges', () => {
    expect(satisfies('1.2.3', '^1.0.0')).toBe(true);
    expect(satisfies('1.0.0', '^1.0.0')).toBe(true);
    expect(satisfies('1.9.9', '^1.2.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.0.0')).toBe(false);
    expect(satisfies('0.9.0', '^1.0.0')).toBe(false);
    expect(satisfies('1.1.0', '^1.2.0')).toBe(false);
  });

  it('handles tilde ranges', () => {
    expect(satisfies('1.2.3', '~1.2.0')).toBe(true);
    expect(satisfies('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.0')).toBe(false);
    expect(satisfies('1.2.0', '~1.2.5')).toBe(false);
  });

  it('handles exact versions', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '1.2.3')).toBe(false);
  });

  it('tolerates a leading v or =', () => {
    expect(satisfies('v1.2.3', '^1.0.0')).toBe(true);
    expect(satisfies('1.2.3', '=1.2.3')).toBe(true);
  });
});
