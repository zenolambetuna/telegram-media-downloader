/**
 * Minimal, dependency-free semver range check supporting the subset needed for
 * provider compatibility: exact (1.2.3), caret (^1.2.3), tilde (~1.2.3), and
 * wildcard (* or x). This avoids adding a runtime dependency for a small need.
 */
function parse(version: string): [number, number, number] {
  const clean = version.trim().replace(/^[v=]/, '');
  const parts = clean.split('.').map((part) => Number.parseInt(part, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export function satisfies(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === '*' || trimmed === 'x' || trimmed === '') {
    return true;
  }

  const [vMajor, vMinor, vPatch] = parse(version);

  if (trimmed.startsWith('^')) {
    const [rMajor, rMinor, rPatch] = parse(trimmed.slice(1));
    if (vMajor !== rMajor) {
      return false;
    }
    if (vMinor < rMinor) {
      return false;
    }
    if (vMinor === rMinor && vPatch < rPatch) {
      return false;
    }
    return true;
  }

  if (trimmed.startsWith('~')) {
    const [rMajor, rMinor, rPatch] = parse(trimmed.slice(1));
    if (vMajor !== rMajor || vMinor !== rMinor) {
      return false;
    }
    return vPatch >= rPatch;
  }

  const [rMajor, rMinor, rPatch] = parse(trimmed);
  return vMajor === rMajor && vMinor === rMinor && vPatch === rPatch;
}
