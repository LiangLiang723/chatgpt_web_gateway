import { runPhase4ChatGptE2E } from '../tests/e2e/chatgpt-phase4.e2e.js';
import { parseRealE2EEnvironment } from '../tests/e2e/environment.js';

const options = parseRealE2EEnvironment(process.env);
const result = await runPhase4ChatGptE2E(options);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
