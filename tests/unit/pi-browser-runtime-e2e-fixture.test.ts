import { describe, expect, it } from 'vitest';

import * as piRuntime from '../e2e/chatgpt-pi-runtime.e2e.js';

interface RealPiFixture {
  provider: string;
  model: string;
  toolNames: string[];
  modelsConfig: {
    providers: Record<
      string,
      {
        baseUrl: string;
        api: string;
        apiKey: string;
        compat?: Record<string, unknown>;
        models: Array<{ id: string; reasoning?: boolean }>;
      }
    >;
  };
  extensionSource: string;
  args: string[];
}

type BuildRealPiRuntimeFixture = (input: {
  gatewayBaseUrl: string;
  apiKey: string;
  token: string;
  extensionPath: string;
  sessionId: string;
  sessionDir: string;
}) => RealPiFixture;

type MergeLocalNoProxy = (value: string | undefined) => string;

function runtimeExport<T>(name: string): T | undefined {
  return (piRuntime as unknown as Record<string, unknown>)[name] as T | undefined;
}

describe('Pi browser-runtime E2E fixture', () => {
  it('drives the installed Pi client with exactly 16 active tools', () => {
    const buildFixture = runtimeExport<BuildRealPiRuntimeFixture>('buildRealPiRuntimeFixture');
    expect(buildFixture).toBeTypeOf('function');
    if (!buildFixture) return;

    const fixture = buildFixture({
      gatewayBaseUrl: 'http://127.0.0.1:43123',
      apiKey: 'fixture-key',
      token: 'FIXTURE_TOKEN',
      extensionPath: '/tmp/pi-runtime-tools.mjs',
      sessionId: 'fixture-session',
      sessionDir: '/tmp/pi-runtime-sessions',
    });

    expect(fixture.provider).toBe('chatgpt-web-gateway-e2e');
    expect(fixture.model).toBe('chatgpt-web');
    expect(fixture.toolNames).toHaveLength(16);
    expect(fixture.toolNames.slice(0, 4)).toEqual(['read', 'bash', 'edit', 'write']);
    expect(new Set(fixture.toolNames).size).toBe(16);
    expect(fixture.extensionSource).toContain('pi_runtime_extra_12');
    expect(fixture.extensionSource).not.toContain('@earendil-works/pi-coding-agent');

    const provider = fixture.modelsConfig.providers[fixture.provider];
    expect(provider).toMatchObject({
      baseUrl: 'http://127.0.0.1:43123/v1',
      api: 'openai-completions',
      apiKey: 'fixture-key',
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStore: false,
        supportsUsageInStreaming: true,
      },
    });
    expect(provider?.models).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'chatgpt-web', reasoning: false })]),
    );
    expect(fixture.args).toEqual(
      expect.arrayContaining([
        '--provider',
        fixture.provider,
        '--model',
        fixture.model,
        '--session-id',
        'fixture-session',
        '--session-dir',
        '/tmp/pi-runtime-sessions',
        '--print',
        '--extension',
        '/tmp/pi-runtime-tools.mjs',
        '--tools',
        fixture.toolNames.join(','),
      ]),
    );
    expect(fixture.args).not.toContain('--no-session');
    expect(fixture.args.at(-1)).toContain('FIXTURE_TOKEN');
  });

  it('keeps an installed Pi proxy while bypassing it for the local Gateway listener', () => {
    const mergeNoProxy = runtimeExport<MergeLocalNoProxy>('mergeLocalGatewayNoProxy');
    expect(mergeNoProxy).toBeTypeOf('function');
    if (!mergeNoProxy) return;

    expect(mergeNoProxy(undefined)).toBe('127.0.0.1,localhost');
    expect(mergeNoProxy('example.test,localhost')).toBe('example.test,localhost,127.0.0.1');
    expect(mergeNoProxy('127.0.0.1')).toBe('127.0.0.1,localhost');
  });
});
