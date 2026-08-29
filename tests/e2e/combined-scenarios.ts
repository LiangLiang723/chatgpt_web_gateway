export type CombinedPhase = 'phase3' | 'phase4' | 'phase5' | 'phase7' | 'phase8';

const DEFAULT_COMBINED_PHASES: readonly CombinedPhase[] = [
  'phase3',
  'phase4',
  'phase5',
  'phase7',
  'phase8',
];

export function parseCombinedPhaseSelection(value: string | undefined): CombinedPhase[] {
  if (value === undefined || value.trim() === '') return [...DEFAULT_COMBINED_PHASES];

  const phases = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (phases.length === 0) return [...DEFAULT_COMBINED_PHASES];

  const allowed = new Set<string>(DEFAULT_COMBINED_PHASES);
  for (const phase of phases) {
    if (!allowed.has(phase)) {
      throw new Error(
        'E2E_CHATGPT_COMBINED_PHASES must contain only: phase3, phase4, phase5, phase7, phase8',
      );
    }
  }

  return [...new Set(phases)] as CombinedPhase[];
}
