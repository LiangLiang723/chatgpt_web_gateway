import { readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
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
const readyFile = '/tmp/maintenance-browser.ready';
const pidFile = '/tmp/maintenance-browser.pid';

process.once('exit', () => {
  rmSync(readyFile, { force: true });
  rmSync(pidFile, { force: true });
});

let context;
let closePromise;
let shutdownRequested = false;
let resolveSignal;
const signalReceived = new Promise((resolve) => {
  resolveSignal = resolve;
});

function removeOwnStaleSingletonFiles() {
  const lockPath = path.join(profileDir, 'SingletonLock');
  let target;
  try {
    target = readlinkSync(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  const prefix = `${hostname()}-`;
  if (!target.startsWith(prefix)) return;
  const browserPid = Number(target.slice(prefix.length));
  if (!Number.isSafeInteger(browserPid) || browserPid < 1) return;

  try {
    process.kill(browserPid, 0);
    return;
  } catch (error) {
    if (error?.code !== 'ESRCH') return;
  }

  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    rmSync(path.join(profileDir, name), { force: true });
  }
}

function requestShutdown(signal) {
  shutdownRequested = true;
  resolveSignal(signal);
  if (context && !closePromise) {
    closePromise = context.close();
  }
}

process.once('SIGTERM', () => requestShutdown('SIGTERM'));
process.once('SIGINT', () => requestShutdown('SIGINT'));

context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1440, height: 900 },
  ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
});
writeFileSync(readyFile, 'ready\n', { mode: 0o600 });

if (shutdownRequested) {
  closePromise ??= context.close();
  await closePromise;
  removeOwnStaleSingletonFiles();
} else {
  const page = context.pages()[0] ?? (await context.newPage());
  if (maintenanceUrl !== 'about:blank') {
    try {
      await page.goto(maintenanceUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (error) {
      if (!shutdownRequested) {
        console.error(
          'Maintenance browser navigation failed; the browser remains open for manual use.',
          error,
        );
      }
    }
  }

  if (shutdownRequested) {
    closePromise ??= context.close();
    await closePromise;
    removeOwnStaleSingletonFiles();
  } else {
    const contextClosed = new Promise((resolve) => {
      context.once('close', () => resolve('context_closed'));
    });
    const closeReason = await Promise.race([contextClosed, signalReceived]);
    if (closeReason !== 'context_closed') {
      closePromise ??= context.close();
      try {
        await closePromise;
        removeOwnStaleSingletonFiles();
      } catch (error) {
        console.error(`Failed to close maintenance browser context: ${String(error)}`);
      }
    }
  }
}
