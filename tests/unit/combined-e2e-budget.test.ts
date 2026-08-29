import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCombinedPhaseSelection } from '../e2e/combined-scenarios.js';

const combinedRunner = readFileSync(resolve('scripts/test-chatgpt-e2e.ts'), 'utf8');

describe('combined real E2E request budget', () => {
  it('uses the single-request Phase 3 gateway regression instead of repeating standalone Phase 3', () => {
    expect(combinedRunner).toContain('runPhase3GatewayRegression');
    expect(combinedRunner).not.toContain('runPhase3ChatGptE2E');
  });

  it('does not repeat the expensive Phase 5 abort scenario after the focused standalone gate', () => {
    expect(combinedRunner).toContain('runAbortScenario: false');
  });

  it('does not repeat the full Phase 6 attachment matrix after the focused standalone gate', () => {
    expect(combinedRunner).not.toContain('runPhase6ChatGptE2E');
    expect(combinedRunner).toContain(
      "phase6 = { attachmentMatrix: 'not_run_in_combined' as const }",
    );
  });

  it('can split the same combined gate into bounded Phase subsets without changing the default set', () => {
    expect(parseCombinedPhaseSelection(undefined)).toEqual([
      'phase3',
      'phase4',
      'phase5',
      'phase7',
      'phase8',
    ]);
    expect(parseCombinedPhaseSelection('phase3,phase4,phase5')).toEqual([
      'phase3',
      'phase4',
      'phase5',
    ]);
    expect(parseCombinedPhaseSelection('phase8')).toEqual(['phase8']);
    expect(() => parseCombinedPhaseSelection('phase6')).toThrow(/E2E_CHATGPT_COMBINED_PHASES/);
  });
});
