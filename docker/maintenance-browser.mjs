import path from 'node:path';

import { chromium } from 'playwright';

import { parseChatGptProxyServer } from '../dist/config/proxy.js';

const dataDir = path.resolve(process.env.DATA_DIR ?? '/data');
const requestedProfileDir = process.env.CHATGPT_PROFILE_DIR?.trim();
const profileDir = requestedProfileDir
  ? path.resolve(requestedProfileDir)
  : path.join(dataDir, 'browser-profile');
if (profileDir !== dataDir && !profileDir.startsWith(`${dataDir}${path.sep}`)) {
  throw new Error('CHATGPT_PROFILE_DIR must stay inside DATA_DIR');
}
const maintenanceUrl = process.env.MAINTENANCE_URL ?? 'https://chatgpt.com/';
const proxyServer = parseChatGptProxyServer(process.env.CHATGPT_PROXY_SERVER);

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1440, height: 900 },
  ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
});

const page = context.pages()[0] ?? (await context.newPage());
if (maintenanceUrl !== 'about:blank') {
  try {
    await page.goto(maintenanceUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (error) {
    console.error(
      'Maintenance browser navigation failed; the browser remains open for manual use.',
      error,
    );
  }
}

await new Promise((resolve) => context.once('close', resolve));
