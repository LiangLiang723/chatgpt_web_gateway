import type { AppConfig } from '../config/index.js';
import type { BrowserManager } from '../browser/types.js';

export interface RuntimeDiagnostics {
  status: 'ready' | 'maintenance';
  ui_mode: AppConfig['uiMode'];
  browser: {
    available: boolean;
    auth_state: 'not_probed';
    pages: {
      open: number;
      leased: number;
      idle: number;
    } | null;
  };
  persistence: {
    sqlite: 'ready';
    files: 'ready';
    generated_images: 'ready';
  };
}

export interface RuntimeDiagnosticsProvider {
  snapshot(): RuntimeDiagnostics;
}

export function createRuntimeDiagnosticsProvider(options: {
  config: AppConfig;
  browser?: BrowserManager;
}): RuntimeDiagnosticsProvider {
  return {
    snapshot() {
      const browser = options.browser;
      return {
        status: browser === undefined ? 'maintenance' : 'ready',
        ui_mode: options.config.uiMode,
        browser: {
          available: browser !== undefined,
          auth_state: 'not_probed',
          pages:
            browser === undefined
              ? null
              : {
                  open: browser.pages.openCount,
                  leased: browser.pages.leasedCount,
                  idle: browser.pages.idleCount,
                },
        },
        persistence: {
          sqlite: 'ready',
          files: 'ready',
          generated_images: 'ready',
        },
      };
    },
  };
}
