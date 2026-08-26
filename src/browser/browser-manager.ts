import { mkdirSync } from 'node:fs';

import { chromium, type BrowserContext } from 'playwright';

import { BrowserRuntimeError } from './errors.js';
import { createPagePool } from './page-pool.js';
import type { BrowserManager } from './types.js';

export interface BrowserLaunchOptions {
  headless: false;
  viewport: { width: number; height: number };
  proxy?: { server: string };
}

export type LaunchPersistentContext = (
  profileDir: string,
  options: BrowserLaunchOptions,
) => Promise<BrowserContext>;

export interface CreateBrowserManagerOptions {
  profileDir: string;
  maxActivePages: number;
  proxyServer?: string;
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
        headless: false,
        viewport: { width: 1440, height: 900 },
        ...(options.proxyServer ? { proxy: { server: options.proxyServer } } : {}),
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
        const message = error instanceof Error ? error.message : String(error);
        const alreadyClosed = /Target page, context or browser has been closed/i.test(message);
        if (pagePoolError === undefined && !alreadyClosed) {
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
