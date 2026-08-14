import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Page } from 'playwright';

import {
  createBrowserManager as defaultCreateBrowserManager,
  type CreateBrowserManagerOptions,
} from '../browser/browser-manager.js';
import type { BrowserManager } from '../browser/types.js';
import { probeAuth } from './auth.js';
import { inspectCollection, inspectUnique } from './selector-registry.js';
import { chatGptSelectors } from './selectors.js';

export interface InspectEnvironment {
  DATA_DIR?: string;
  CHATGPT_PROFILE_DIR?: string;
  CHATGPT_DIAGNOSTICS_DIR?: string;
}

export interface ParsedInspectEnvironment {
  profileDir: string;
  diagnosticsDir?: string;
}

export interface InspectChatGptOptions {
  profileDir: string;
  diagnosticsDir?: string;
  createBrowserManager?: (options: CreateBrowserManagerOptions) => Promise<BrowserManager>;
  mkdir?: typeof mkdirSync;
  writeFile?: typeof writeFileSync;
}

export interface InspectChatGptResult {
  url: string;
  auth: 'authenticated' | 'auth_required' | 'unknown';
  selectors: {
    composer: 'unique' | 'missing' | 'ambiguous';
    sendButton: 'unique' | 'missing' | 'ambiguous';
    assistantTurns: { status: 'collection'; count: number };
    stopControl: 'unique' | 'missing' | 'ambiguous';
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseInspectEnvironment(env: InspectEnvironment): ParsedInspectEnvironment {
  const profile = nonEmpty(env.CHATGPT_PROFILE_DIR);
  if (!profile) throw new Error('e2e_profile_required');

  const profileDir = resolve(profile);
  const dataDir = resolve(nonEmpty(env.DATA_DIR) ?? '/data');
  const productionProfile = resolve(dataDir, 'browser-profile');
  if (profileDir === productionProfile) throw new Error('e2e_profile_must_be_isolated');

  const diagnostics = nonEmpty(env.CHATGPT_DIAGNOSTICS_DIR);
  return {
    profileDir,
    ...(diagnostics ? { diagnosticsDir: resolve(diagnostics) } : {}),
  };
}

function uniqueStatus(
  value: Awaited<ReturnType<typeof inspectUnique>>,
): 'unique' | 'missing' | 'ambiguous' {
  return value.status;
}

async function inspectPage(page: Page): Promise<InspectChatGptResult> {
  await page.goto('https://chatgpt.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  const auth = await probeAuth(page);
  const composer = await inspectUnique(page, chatGptSelectors.composer);
  const sendButton = await inspectUnique(page, chatGptSelectors.sendButton);
  const assistantTurns = await inspectCollection(page, chatGptSelectors.assistantTurns);
  const stopControl = await inspectUnique(page, chatGptSelectors.stopControl);

  return {
    url: page.url(),
    auth: auth.state,
    selectors: {
      composer: uniqueStatus(composer),
      sendButton: uniqueStatus(sendButton),
      assistantTurns: { status: 'collection', count: assistantTurns.count },
      stopControl: uniqueStatus(stopControl),
    },
  };
}

export async function inspectChatGpt(
  options: InspectChatGptOptions,
): Promise<InspectChatGptResult> {
  const browser = await (options.createBrowserManager ?? defaultCreateBrowserManager)({
    profileDir: options.profileDir,
    maxActivePages: 1,
  });
  const mkdir = options.mkdir ?? mkdirSync;
  const writeFile = options.writeFile ?? writeFileSync;

  try {
    const lease = await browser.pages.acquire();
    try {
      const result = await inspectPage(lease.page);
      if (options.diagnosticsDir) {
        mkdir(options.diagnosticsDir, { recursive: true });
        await lease.page.screenshot({
          path: join(options.diagnosticsDir, 'chatgpt.png'),
          fullPage: true,
        });
        writeFile(join(options.diagnosticsDir, 'chatgpt.html'), await lease.page.content(), 'utf8');
      }
      return result;
    } finally {
      await lease.release();
    }
  } finally {
    await browser.close();
  }
}
