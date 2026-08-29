import { runPhase6ChatGptE2E } from '../tests/e2e/chatgpt-phase6.e2e.js';
import { parseRealE2EEnvironment } from '../tests/e2e/environment.js';
import { parsePhase6Scenario } from '../tests/e2e/phase6-scenarios.js';

const options = parseRealE2EEnvironment(process.env);
const result = await runPhase6ChatGptE2E({
  ...options,
  scenario: parsePhase6Scenario(process.env.E2E_CHATGPT_PHASE6_SCENARIO),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
