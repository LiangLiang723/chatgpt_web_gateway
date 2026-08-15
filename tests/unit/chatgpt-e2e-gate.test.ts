import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseRealE2EEnvironment } from '../e2e/environment.js';

describe('real ChatGPT E2E environment gate', () => {
  it('requires the explicit E2E enable flag', () => {
    expect(() => parseRealE2EEnvironment({ CHATGPT_PROFILE_DIR: '/tmp/e2e-profile' })).toThrow(
      /E2E_CHATGPT=1/,
    );
  });

  it('requires an explicit isolated Profile after the enable flag', () => {
    expect(() => parseRealE2EEnvironment({ E2E_CHATGPT: '1' })).toThrow(/e2e_profile_required/);
    expect(() =>
      parseRealE2EEnvironment({
        E2E_CHATGPT: '1',
        DATA_DIR: '/data',
        CHATGPT_PROFILE_DIR: '/data/browser-profile',
      }),
    ).toThrow(/e2e_profile_must_be_isolated/);
  });

  it('rejects credential-bearing proxy URLs for real E2E', () => {
    expect(() =>
      parseRealE2EEnvironment({
        E2E_CHATGPT: '1',
        CHATGPT_PROFILE_DIR: '/tmp/e2e-profile',
        CHATGPT_PROXY_SERVER: 'http://user:pass@proxy.example:7890',
      }),
    ).toThrow(/CHATGPT_PROXY_SERVER/);
  });

  it('returns normalized isolated E2E paths', () => {
    expect(
      parseRealE2EEnvironment({
        E2E_CHATGPT: '1',
        DATA_DIR: '/data',
        CHATGPT_PROFILE_DIR: './e2e-browser-profile',
        CHATGPT_DIAGNOSTICS_DIR: './chatgpt-diagnostics',
        CHATGPT_PROXY_SERVER: 'http://proxy.example:7890',
      }),
    ).toEqual({
      profileDir: resolve('./e2e-browser-profile'),
      diagnosticsDir: resolve('./chatgpt-diagnostics'),
      proxyServer: 'http://proxy.example:7890',
    });
  });
});
