import type { CanonicalInstructions } from './types.js';

export interface CanonicalInstructionInput {
  role: 'system' | 'developer';
  content: string;
}

export function canonicalizeText(parts: readonly string[]): string {
  return parts.join('\n');
}

export function canonicalizeInstructions(
  instructions: readonly CanonicalInstructionInput[],
): CanonicalInstructions {
  const system: string[] = [];
  const developer: string[] = [];
  for (const instruction of instructions) {
    if (instruction.role === 'system') system.push(instruction.content);
    else developer.push(instruction.content);
  }
  return { system, developer };
}
