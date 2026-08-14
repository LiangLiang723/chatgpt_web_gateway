import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Page } from 'playwright';

import { probeAuth } from './auth.js';
import { asChatGptDriverError } from './errors.js';
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

export interface InspectChatGptPageOptions {
  diagnosticsDir?: string;
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

export async function inspectChatGptPage(
  page: Page,
  options: InspectChatGptPageOptions = {},
): Promise<InspectChatGptResult> {
  try {
    await page.goto('https://chatgpt.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    const auth = await probeAuth(page);
    const composer = await inspectUnique(page, chatGptSelectors.composer);
    const sendButton = await inspectUnique(page, chatGptSelectors.sendButton);
    const assistantTurns = await inspectCollection(page, chatGptSelectors.assistantTurns);
    const stopControl = await inspectUnique(page, chatGptSelectors.stopControl);

    if (options.diagnosticsDir) {
      const mkdir = options.mkdir ?? mkdirSync;
      const writeFile = options.writeFile ?? writeFileSync;
      mkdir(options.diagnosticsDir, { recursive: true });
      await page.screenshot({
        path: join(options.diagnosticsDir, 'chatgpt.png'),
        fullPage: true,
      });
      writeFile(join(options.diagnosticsDir, 'chatgpt.html'), await page.content(), 'utf8');
    }

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
  } catch (error) {
    throw asChatGptDriverError(error, 'ChatGPT inspection page operation failed');
  }
}
