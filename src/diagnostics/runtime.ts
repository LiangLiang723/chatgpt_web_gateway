import type { Page } from 'playwright';

import type { BrowserManager, PageLease } from '../browser/types.js';
import { probeAuth, type ChatGptAuthState } from '../chatgpt/auth.js';
import type { AppConfig } from '../config/index.js';

export type RuntimeDiagnosticsAuthState =
  'authenticated' | 'auth_required' | 'unknown' | 'not_probed';

export interface RuntimeDiagnostics {
  status: 'ready' | 'maintenance';
  ui_mode: AppConfig['uiMode'];
  browser: {
    available: boolean;
    auth_state: RuntimeDiagnosticsAuthState;
    pages: {
      open: number;
      leased: number;
      idle: number;
    } | null;
    probe: {
      status: 'ok' | 'capacity_exceeded' | 'failed';
      page_url: string | null;
      document_state: string | null;
    } | null;
  };
  persistence: {
    sqlite: 'ready';
    files: 'ready';
    generated_images: 'ready';
  };
}

export interface RuntimeDiagnosticsProvider {
  snapshot(): Promise<RuntimeDiagnostics>;
}

function authStateValue(state: ChatGptAuthState): RuntimeDiagnosticsAuthState {
  return state.state;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function safePageUrl(page: Page): string | null {
  try {
    return page.url();
  } catch {
    return null;
  }
}

async function safeDocumentState(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => document.readyState);
  } catch {
    return null;
  }
}

export function createRuntimeDiagnosticsProvider(options: {
  config: AppConfig;
  browser?: BrowserManager;
  probeAuth?: typeof probeAuth;
  navigationTimeoutMs?: number;
}): RuntimeDiagnosticsProvider {
  const authProbe = options.probeAuth ?? probeAuth;
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 60_000;

  const persistence = {
    sqlite: 'ready' as const,
    files: 'ready' as const,
    generated_images: 'ready' as const,
  };

  return {
    async snapshot() {
      const browser = options.browser;
      if (browser === undefined) {
        return {
          status: 'maintenance',
          ui_mode: options.config.uiMode,
          browser: {
            available: false,
            auth_state: 'not_probed',
            pages: null,
            probe: null,
          },
          persistence,
        };
      }

      const pages = {
        open: browser.pages.openCount,
        leased: browser.pages.leasedCount,
        idle: browser.pages.idleCount,
      };
      let lease: PageLease | undefined;
      try {
        lease = await browser.pages.acquire();
      } catch (error) {
        return {
          status: 'ready',
          ui_mode: options.config.uiMode,
          browser: {
            available: true,
            auth_state: 'not_probed',
            pages,
            probe: {
              status:
                errorCode(error) === 'page_capacity_exceeded' ? 'capacity_exceeded' : 'failed',
              page_url: null,
              document_state: null,
            },
          },
          persistence,
        };
      }

      try {
        await lease.page.goto('https://chatgpt.com/', {
          waitUntil: 'domcontentloaded',
          timeout: navigationTimeoutMs,
        });
        const authState = await authProbe(lease.page);
        return {
          status: 'ready',
          ui_mode: options.config.uiMode,
          browser: {
            available: true,
            auth_state: authStateValue(authState),
            pages,
            probe: {
              status: 'ok',
              page_url: safePageUrl(lease.page),
              document_state: await safeDocumentState(lease.page),
            },
          },
          persistence,
        };
      } catch {
        return {
          status: 'ready',
          ui_mode: options.config.uiMode,
          browser: {
            available: true,
            auth_state: 'unknown',
            pages,
            probe: {
              status: 'failed',
              page_url: safePageUrl(lease.page),
              document_state: await safeDocumentState(lease.page),
            },
          },
          persistence,
        };
      } finally {
        await lease.release().catch(() => undefined);
      }
    },
  };
}
