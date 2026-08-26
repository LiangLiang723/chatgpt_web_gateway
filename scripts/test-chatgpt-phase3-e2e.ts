import { runPhase3ChatGptE2E } from '../tests/e2e/chatgpt-phase3.e2e.js';
import { parseRealE2EEnvironment } from '../tests/e2e/environment.js';
import { cloneRealE2EProfile } from '../tests/e2e/profile.js';

const options = parseRealE2EEnvironment(process.env);
const profile = cloneRealE2EProfile(options.profileDir);
try {
  const result = await runPhase3ChatGptE2E({
    ...options,
    profileDir: profile.profileDir,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  profile.cleanup();
}
