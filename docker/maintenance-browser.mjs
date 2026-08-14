import path from 'node:path';

import { chromium } from 'playwright';

const dataDir = process.env.DATA_DIR ?? '/data';
const profileDir = path.join(dataDir, 'browser-profile');
const maintenanceUrl = process.env.MAINTENANCE_URL ?? 'https://chatgpt.com/';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1440, height: 900 },
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
