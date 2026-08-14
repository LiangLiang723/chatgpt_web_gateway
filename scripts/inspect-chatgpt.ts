import { createBrowserManager } from '../src/browser/browser-manager.js';
import { inspectChatGptPage, parseInspectEnvironment } from '../src/chatgpt/inspect.js';

const options = parseInspectEnvironment(process.env);
const browser = await createBrowserManager({
  profileDir: options.profileDir,
  maxActivePages: 1,
});

try {
  const lease = await browser.pages.acquire();
  try {
    const result = await inspectChatGptPage(lease.page, {
      ...(options.diagnosticsDir ? { diagnosticsDir: options.diagnosticsDir } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await lease.release();
  }
} finally {
  await browser.close();
}
