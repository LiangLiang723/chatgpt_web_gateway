import { spawn } from 'node:child_process';
import { lstatSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
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
const lockPath = path.join(profileDir, 'SingletonLock');

process.once('exit', () => {
  rmSync(readyFile, { force: true });
  rmSync(pidFile, { force: true });
});

function removeOwnStaleSingletonFiles() {
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

const chromeArgs = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic',
  '--use-mock-keychain',
  ...(proxyServer ? [`--proxy-server=${proxyServer}`, '--proxy-bypass-list=<-loopback>'] : []),
  maintenanceUrl,
];

let shutdownRequested = false;
let requestedSignal = 'SIGTERM';
let browser;

function requestShutdown(signal) {
  shutdownRequested = true;
  requestedSignal = signal;
  if (browser && browser.exitCode === null) {
    browser.kill(signal);
  }
}

process.once('SIGTERM', () => requestShutdown('SIGTERM'));
process.once('SIGINT', () => requestShutdown('SIGINT'));

browser = spawn(chromium.executablePath(), chromeArgs, {
  stdio: 'inherit',
});

const browserExit = new Promise((resolve, reject) => {
  browser.once('error', reject);
  browser.once('exit', (code, signal) => resolve({ code, signal }));
});

if (shutdownRequested && browser.exitCode === null) {
  browser.kill(requestedSignal);
}

let ready = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  if (browser.exitCode !== null) break;
  try {
    lstatSync(lockPath);
    ready = true;
    break;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

if (!ready) {
  if (browser.exitCode === null) browser.kill('SIGTERM');
  const result = await browserExit;
  removeOwnStaleSingletonFiles();
  throw new Error(
    `Maintenance Chromium exited before Profile lock became ready: ${JSON.stringify(result)}`,
  );
}

writeFileSync(readyFile, 'ready\n', { mode: 0o600 });

const result = await browserExit;
removeOwnStaleSingletonFiles();

if (!shutdownRequested && result.code !== 0) {
  throw new Error(`Maintenance Chromium exited unexpectedly: ${JSON.stringify(result)}`);
}
