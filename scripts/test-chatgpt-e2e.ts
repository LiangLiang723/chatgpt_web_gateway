import { runPhase3ChatGptE2E } from '../tests/e2e/chatgpt-phase3.e2e.js';
import { runPhase4ChatGptE2E } from '../tests/e2e/chatgpt-phase4.e2e.js';
import { parseRealE2EEnvironment } from '../tests/e2e/environment.js';
import { cloneRealE2EProfile } from '../tests/e2e/profile.js';

const options = parseRealE2EEnvironment(process.env);
const phase3Profile = cloneRealE2EProfile(options.profileDir);
try {
  const phase3 = await runPhase3ChatGptE2E({
    ...options,
    profileDir: phase3Profile.profileDir,
  });
  const phase4 = await runPhase4ChatGptE2E(options);
  process.stdout.write(`${JSON.stringify({ phase3, phase4 }, null, 2)}\n`);
} finally {
  phase3Profile.cleanup();
}
