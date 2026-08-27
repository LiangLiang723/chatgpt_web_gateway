import type { NormalizedTool, NormalizedToolChoice } from '../api/normalized.js';
import { fingerprintCanonical } from '../context/fingerprint.js';

export interface CanonicalFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: unknown;
}

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

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(compareCodePoints)) {
    const item = stabilize(source[key]);
    if (item !== undefined) result[key] = item;
  }
  return result;
}

export function canonicalizeTools(tools: readonly NormalizedTool[]): CanonicalFunctionTool[] {
  const names = new Set<string>();
  const canonical = tools.map((tool) => {
    const name = tool.name;
    if (name.trim().length === 0) throw new Error('Tool function name must not be empty');
    if (names.has(name)) throw new Error(`Duplicate tool function name: ${name}`);
    names.add(name);
    return {
      type: 'function' as const,
      name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: stabilize(tool.parameters),
    };
  });
  canonical.sort((left, right) => compareCodePoints(left.name, right.name));
  return canonical;
}

export function fingerprintTools(tools: readonly NormalizedTool[]): string | undefined {
  if (tools.length === 0) return undefined;
  return fingerprintCanonical(canonicalizeTools(tools));
}

export function validateToolChoice(
  tools: readonly NormalizedTool[],
  choice: NormalizedToolChoice,
): void {
  const canonical = canonicalizeTools(tools);
  if (choice.mode === 'required' && canonical.length === 0) {
    throw new Error('Tool choice required requires at least one tool');
  }
  if (choice.mode !== 'function') return;
  if (canonical.length === 0) {
    throw new Error(`Tool choice function ${choice.name} requires at least one tool`);
  }
  if (!canonical.some((tool) => tool.name === choice.name)) {
    throw new Error(`Forced tool function does not exist: ${choice.name}`);
  }
}
