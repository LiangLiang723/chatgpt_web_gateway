import { runPhase7ChatGptE2E } from '../tests/e2e/chatgpt-phase7.e2e.js';
import { parseRealE2EEnvironment } from '../tests/e2e/environment.js';

const options = parseRealE2EEnvironment(process.env);
const result = await runPhase7ChatGptE2E(options);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
