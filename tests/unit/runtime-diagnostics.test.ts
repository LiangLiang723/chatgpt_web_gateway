import type { BrowserContext, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { BrowserRuntimeError } from '../../src/browser/errors.js';
import type { BrowserManager, PageLease, PagePool } from '../../src/browser/types.js';
import { loadConfig } from '../../src/config/index.js';
import { createRuntimeDiagnosticsProvider } from '../../src/diagnostics/runtime.js';

function browserHarness(options: {
  authState?: 'authenticated' | 'auth_required' | 'unknown';
  acquireError?: Error;
  gotoError?: Error;
}) {
  const page = {
    goto: vi.fn(async () => {
      if (options.gotoError) throw options.gotoError;
    }),
    url: vi.fn(() => 'https://chatgpt.com/'),
    evaluate: vi.fn(async () => 'complete'),
    isClosed: vi.fn(() => false),
  } as unknown as Page;
  const lease: PageLease = {
    page,
    release: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const pages: PagePool = {
    openCount: 3,
    leasedCount: 1,
    idleCount: 2,
    acquire: vi.fn(async () => {
      if (options.acquireError) throw options.acquireError;
      return lease;
    }),
    close: vi.fn(async () => undefined),
  };
  const browser: BrowserManager = {
    context: {} as BrowserContext,
    pages,
    close: vi.fn(async () => undefined),
  };
  const probeAuth = vi.fn(async () => {
    if (options.authState === 'auth_required') return { state: 'auth_required' as const };
    if (options.authState === 'unknown') {
      return { state: 'unknown' as const, reason: 'missing-signals' };
    }
    return { state: 'authenticated' as const };
  });
  return { browser, lease, page, probeAuth };
}

describe('runtime diagnostics active ChatGPT probe', () => {
  it.each([
    ['authenticated', 'authenticated'],
    ['auth_required', 'auth_required'],
    ['unknown', 'unknown'],
  ] as const)(
    'probes ChatGPT explicitly and reports auth state %s',
    async (authState, expected) => {
      const harness = browserHarness({ authState });
      const provider = createRuntimeDiagnosticsProvider({
        config: loadConfig({ GATEWAY_API_KEY: 'test-key' }),
        browser: harness.browser,
        probeAuth: harness.probeAuth,
        navigationTimeoutMs: 1234,
      });

      const snapshot = await provider.snapshot();

      expect(harness.browser.pages.acquire).toHaveBeenCalledTimes(1);
      expect(harness.page.goto).toHaveBeenCalledWith('https://chatgpt.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 1234,
      });
      expect(harness.probeAuth).toHaveBeenCalledWith(harness.page);
      expect(harness.lease.release).toHaveBeenCalledTimes(1);
      expect(snapshot.browser).toEqual({
        available: true,
        auth_state: expected,
        pages: { open: 3, leased: 1, idle: 2 },
        probe: {
          status: 'ok',
          page_url: 'https://chatgpt.com/',
          document_state: 'complete',
        },
      });
    },
  );

  it('reports capacity exhaustion without navigating or disturbing retained pages', async () => {
    const harness = browserHarness({
      acquireError: new BrowserRuntimeError('page_capacity_exceeded', 'full'),
    });
    const provider = createRuntimeDiagnosticsProvider({
      config: loadConfig({ GATEWAY_API_KEY: 'test-key' }),
      browser: harness.browser,
      probeAuth: harness.probeAuth,
    });

    const snapshot = await provider.snapshot();

    expect(harness.page.goto).not.toHaveBeenCalled();
    expect(harness.probeAuth).not.toHaveBeenCalled();
    expect(harness.lease.release).not.toHaveBeenCalled();
    expect(snapshot.browser).toMatchObject({
      available: true,
      auth_state: 'not_probed',
      probe: {
        status: 'capacity_exceeded',
        page_url: null,
        document_state: null,
      },
    });
  });

  it('reports probe failure and always releases an acquired page lease', async () => {
    const harness = browserHarness({ gotoError: new Error('navigation failed') });
    const provider = createRuntimeDiagnosticsProvider({
      config: loadConfig({ GATEWAY_API_KEY: 'test-key' }),
      browser: harness.browser,
      probeAuth: harness.probeAuth,
    });

    const snapshot = await provider.snapshot();

    expect(harness.lease.release).toHaveBeenCalledTimes(1);
    expect(snapshot.browser).toMatchObject({
      available: true,
      auth_state: 'unknown',
      probe: {
        status: 'failed',
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('navigation failed');
  });

  it('keeps maintenance diagnostics local-only when no Browser runtime exists', async () => {
    const provider = createRuntimeDiagnosticsProvider({
      config: loadConfig({ GATEWAY_API_KEY: 'test-key', UI_MODE: 'novnc' }),
    });

    await expect(provider.snapshot()).resolves.toMatchObject({
      status: 'maintenance',
      browser: {
        available: false,
        auth_state: 'not_probed',
        pages: null,
        probe: null,
      },
    });
  });
});
