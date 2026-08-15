import { createHash } from 'node:crypto';

function stabilize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stabilize(item));
  if (value === null || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = stabilize((value as Record<string, unknown>)[key]);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

export function fingerprintCanonical(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stabilize(value)))
    .digest('hex');
}
