import { runPhase3GatewayRegression } from '../tests/e2e/chatgpt-phase3.e2e.js';
import { runPhase4ChatGptE2E } from '../tests/e2e/chatgpt-phase4.e2e.js';
import { runPhase5ChatGptE2E } from '../tests/e2e/chatgpt-phase5.e2e.js';
import { runPhase7ChatGptE2E } from '../tests/e2e/chatgpt-phase7.e2e.js';
import { runPhase8ChatGptE2E } from '../tests/e2e/chatgpt-phase8.e2e.js';
import { parseCombinedPhaseSelection } from '../tests/e2e/combined-scenarios.js';
import { parseRealE2EEnvironment, requireCombinedRealE2E } from '../tests/e2e/environment.js';
import { cloneRealE2EProfile } from '../tests/e2e/profile.js';

const options = parseRealE2EEnvironment(process.env);
requireCombinedRealE2E(process.env);
const selectedPhases = new Set(
  parseCombinedPhaseSelection(process.env.E2E_CHATGPT_COMBINED_PHASES),
);
const phase6 = { attachmentMatrix: 'not_run_in_combined' as const };
const result: Record<string, unknown> = { phase6 };

if (selectedPhases.has('phase3')) {
  const phase3Profile = cloneRealE2EProfile(options.profileDir);
  try {
    result.phase3 = await runPhase3GatewayRegression({
      ...options,
      profileDir: phase3Profile.profileDir,
    });
  } finally {
    phase3Profile.cleanup();
  }
}
if (selectedPhases.has('phase4')) result.phase4 = await runPhase4ChatGptE2E(options);
if (selectedPhases.has('phase5')) {
  result.phase5 = await runPhase5ChatGptE2E({ ...options, runAbortScenario: false });
}
if (selectedPhases.has('phase7')) result.phase7 = await runPhase7ChatGptE2E(options);
if (selectedPhases.has('phase8')) result.phase8 = await runPhase8ChatGptE2E(options);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
