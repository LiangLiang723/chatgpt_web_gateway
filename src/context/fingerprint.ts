import { createHash } from 'node:crypto';

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = a[index]?.codePointAt(0) ?? 0;
    const rightPoint = b[index]?.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return a.length - b.length;
}

function stabilize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stabilize(item));
  if (value === null || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareCodePoints)) {
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
