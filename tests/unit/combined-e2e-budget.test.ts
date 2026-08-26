import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const combinedRunner = readFileSync(resolve('scripts/test-chatgpt-e2e.ts'), 'utf8');

describe('combined real E2E request budget', () => {
  it('uses the single-request Phase 3 gateway regression instead of repeating standalone Phase 3', () => {
    expect(combinedRunner).toContain('runPhase3GatewayRegression');
    expect(combinedRunner).not.toContain('runPhase3ChatGptE2E');
  });
});
