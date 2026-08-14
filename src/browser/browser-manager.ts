import { mkdirSync } from 'node:fs';

import { chromium, type BrowserContext } from 'playwright';

import { BrowserRuntimeError } from './errors.js';
import { createPagePool } from './page-pool.js';
import type { BrowserManager } from './types.js';

export interface BrowserLaunchOptions {
  headless: true;
  viewport: { width: number; height: number };
}

export type LaunchPersistentContext = (
  profileDir: string,
  options: BrowserLaunchOptions,
) => Promise<BrowserContext>;

export interface CreateBrowserManagerOptions {
  profileDir: string;
  maxActivePages: number;
  launchPersistentContext?: LaunchPersistentContext;
}

const defaultLaunchPersistentContext: LaunchPersistentContext = (profileDir, options) =>
  chromium.launchPersistentContext(profileDir, options);

export async function createBrowserManager(
  options: CreateBrowserManagerOptions,
): Promise<BrowserManager> {
  mkdirSync(options.profileDir, { recursive: true });

  let context: BrowserContext;
  try {
    context = await (options.launchPersistentContext ?? defaultLaunchPersistentContext)(
      options.profileDir,
      {
        headless: true,
        viewport: { width: 1440, height: 900 },
      },
    );
  } catch (error) {
    throw new BrowserRuntimeError(
      'browser_unavailable',
      'Failed to launch persistent Chromium context',
      error,
    );
  }

  const pages = createPagePool(context, { maxOpenPages: options.maxActivePages });
  let closed = false;

  return {
    context,
    pages,
    async close() {
      if (closed) return;
      closed = true;

      let pagePoolError: unknown;
      try {
        await pages.close();
      } catch (error) {
        pagePoolError = error;
      }

      try {
        await context.close();
      } catch (error) {
        if (pagePoolError === undefined) {
          throw new BrowserRuntimeError(
            'browser_unavailable',
            'Failed to close browser context',
            error,
          );
        }
      }

      if (pagePoolError !== undefined) throw pagePoolError;
    },
  };
}
