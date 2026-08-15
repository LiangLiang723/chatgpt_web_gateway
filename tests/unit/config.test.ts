import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/index.js';

describe('loadConfig', () => {
  it('uses approved defaults when only the API key is provided', () => {
    expect(loadConfig({ GATEWAY_API_KEY: 'secret' })).toEqual({
      host: '0.0.0.0',
      port: 3000,
      gatewayApiKey: 'secret',
      uiMode: 'headless',
      puid: 1000,
      pgid: 1000,
      dataDir: '/data',
      maxActivePages: 4,
      pageIdleTimeoutMinutes: 30,
      chatgptProxyServer: undefined,
      novncPort: 6080,
      novncPassword: undefined,
    });
  });

  it('requires a non-empty Gateway API key', () => {
    expect(() => loadConfig({})).toThrow(/GATEWAY_API_KEY/);
    expect(() => loadConfig({ GATEWAY_API_KEY: '   ' })).toThrow(/GATEWAY_API_KEY/);
  });

  it('parses explicit runtime overrides', () => {
    expect(
      loadConfig({
        GATEWAY_API_KEY: 'secret',
        HOST: '127.0.0.1',
        PORT: '4567',
        UI_MODE: 'novnc',
        PUID: '1200',
        PGID: '1300',
        DATA_DIR: '/srv/gateway',
        MAX_ACTIVE_PAGES: '7',
        PAGE_IDLE_TIMEOUT_MINUTES: '12',
        CHATGPT_PROXY_SERVER: ' http://proxy.example:7890 ',
        NOVNC_PORT: '7777',
        NOVNC_PASSWORD: 'maintenance-secret',
      }),
    ).toEqual({
      host: '127.0.0.1',
      port: 4567,
      gatewayApiKey: 'secret',
      uiMode: 'novnc',
      puid: 1200,
      pgid: 1300,
      dataDir: '/srv/gateway',
      maxActivePages: 7,
      pageIdleTimeoutMinutes: 12,
      chatgptProxyServer: 'http://proxy.example:7890',
      novncPort: 7777,
      novncPassword: 'maintenance-secret',
    });
  });

  it('accepts PAGE_IDLE_TIMEOUT_MINUTES boundary values', () => {
    expect(loadConfig({ GATEWAY_API_KEY: 'x', PAGE_IDLE_TIMEOUT_MINUTES: '1' }).pageIdleTimeoutMinutes).toBe(1);
    expect(loadConfig({ GATEWAY_API_KEY: 'x', PAGE_IDLE_TIMEOUT_MINUTES: '1440' }).pageIdleTimeoutMinutes).toBe(1440);
  });

  it('rejects invalid numeric runtime values', () => {
    expect(() => loadConfig({ GATEWAY_API_KEY: 'x', PORT: '0' })).toThrow(/PORT/);
    expect(() => loadConfig({ GATEWAY_API_KEY: 'x', PORT: '65536' })).toThrow(/PORT/);
    expect(() => loadConfig({ GATEWAY_API_KEY: 'x', PUID: '-1' })).toThrow(/PUID/);
    expect(() => loadConfig({ GATEWAY_API_KEY: 'x', PGID: 'not-a-number' })).toThrow(/PGID/);
    expect(() => loadConfig({ GATEWAY_API_KEY: 'x', NOVNC_PORT: '0' })).toThrow(/NOVNC_PORT/);
    expect(() => loadConfig({ GATEWAY_API_KEY: 'x', MAX_ACTIVE_PAGES: '0' })).toThrow(
      /MAX_ACTIVE_PAGES/,
    );
    expect(() => loadConfig({ GATEWAY_API_KEY: 'x', MAX_ACTIVE_PAGES: '33' })).toThrow(
      /MAX_ACTIVE_PAGES/,
    );
    expect(() => loadConfig({ GATEWAY_API_KEY: 'x', PAGE_IDLE_TIMEOUT_MINUTES: '0' })).toThrow(
      /PAGE_IDLE_TIMEOUT_MINUTES/,
    );
    expect(() => loadConfig({ GATEWAY_API_KEY: 'x', PAGE_IDLE_TIMEOUT_MINUTES: '1441' })).toThrow(
      /PAGE_IDLE_TIMEOUT_MINUTES/,
    );
    expect(() =>
      loadConfig({ GATEWAY_API_KEY: 'x', PAGE_IDLE_TIMEOUT_MINUTES: '1.5' }),
    ).toThrow(/PAGE_IDLE_TIMEOUT_MINUTES/);
  });

  it('rejects unsupported UI modes', () => {
    expect(() => loadConfig({ GATEWAY_API_KEY: 'x', UI_MODE: 'desktop' })).toThrow(/UI_MODE/);
  });

  it('rejects invalid or credential-bearing ChatGPT proxy servers', () => {
    for (const value of [
      'not-a-url',
      'ftp://proxy.example:21',
      'http://user:pass@proxy.example:7890',
    ]) {
      expect(() => loadConfig({ GATEWAY_API_KEY: 'x', CHATGPT_PROXY_SERVER: value })).toThrow(
        /CHATGPT_PROXY_SERVER/,
      );
    }
  });
});
