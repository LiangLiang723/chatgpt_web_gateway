import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from 'playwright';

import { LARGE_MULTILINE_PASTE_THRESHOLD_BYTES } from '../../src/chatgpt/composer-input.js';
import {
  createChatGptDriver,
  type ChatGptStreamingTextDriver,
  type ChatGptTextRequest,
  type ChatGptTextResult,
  type ChatGptTextTurn,
} from '../../src/chatgpt/driver.js';
import { loadConfig } from '../../src/config/index.js';
import { createGatewayRuntime, type GatewayRuntime } from '../../src/runtime.js';
import { cloneRealE2EProfile } from './profile.js';

const PI_RUNTIME_PROVIDER = 'chatgpt-web-gateway-e2e';
const PI_RUNTIME_MODEL = 'chatgpt-web';
const PI_RUNTIME_API_KEY = 'pi-runtime-e2e-key';
const PI_RUNTIME_PROCESS_TIMEOUT_MS = 300_000;
const PI_BUILTIN_TOOL_NAMES = ['read', 'bash', 'edit', 'write'] as const;
const PI_EXTRA_TOOL_NAMES = Array.from(
  { length: 12 },
  (_, index) => `pi_runtime_extra_${String(index + 1).padStart(2, '0')}`,
);

export interface RunPiBrowserRuntimeE2EOptions {
  profileDir: string;
  proxyServer?: string;
}

export interface PiBrowserRuntimeE2EResult {
  realPi: true;
  piVersion: string;
  piOutput: true;
  promptUtf8Bytes: number;
  declaredTools: 16;
  gatewayRequests: 1;
}

interface DriverCall {
  prompt?: string;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RealPiRuntimeFixture {
  provider: string;
  model: string;
  toolNames: string[];
  modelsConfig: {
    providers: Record<
      string,
      {
        baseUrl: string;
        api: 'openai-completions';
        apiKey: string;
        compat: {
          supportsDeveloperRole: false;
          supportsReasoningEffort: false;
          supportsStore: false;
          supportsUsageInStreaming: true;
        };
        models: Array<{
          id: string;
          name: string;
          reasoning: false;
          input: ['text'];
          contextWindow: number;
          maxTokens: number;
        }>;
      }
    >;
  };
  extensionSource: string;
  args: string[];
}

function createRecordingDriver(calls: DriverCall[]): ChatGptStreamingTextDriver {
  const driver = createChatGptDriver();
  return {
    openFresh: (page: Page) => driver.openFresh(page),
    openConversation: (page: Page, conversationUrl: string) =>
      driver.openConversation(page, conversationUrl),
    async sendText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextResult> {
      calls.push({ prompt: request.prompt });
      return driver.sendText(page, request);
    },
    async startText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextTurn> {
      calls.push({ prompt: request.prompt });
      return driver.startText(page, request);
    },
  };
}

function extensionSource(): string {
  const registrations = PI_EXTRA_TOOL_NAMES.map(
    (name) => `  pi.registerTool({
    name: ${JSON.stringify(name)},
    label: ${JSON.stringify(name)},
    description: 'Compatibility probe tool with a deterministic string argument.',
    promptSnippet: 'Probe external compatibility with a deterministic string argument.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      return {
        content: [{ type: 'text', text: String(params.value) }],
        details: {},
      };
    },
  });`,
  ).join('\n');

  return `export default function registerPiRuntimeTools(pi) {\n${registrations}\n}\n`;
}

export function mergeLocalGatewayNoProxy(value: string | undefined): string {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const local of ['127.0.0.1', 'localhost']) {
    if (!entries.includes(local)) entries.push(local);
  }
  return entries.join(',');
}

export function buildRealPiRuntimeFixture(input: {
  gatewayBaseUrl: string;
  apiKey: string;
  token: string;
  extensionPath: string;
}): RealPiRuntimeFixture {
  const toolNames = [...PI_BUILTIN_TOOL_NAMES, ...PI_EXTRA_TOOL_NAMES];
  assert.equal(toolNames.length, 16);
  const baseUrl = `${input.gatewayBaseUrl.replace(/\/+$/, '')}/v1`;

  return {
    provider: PI_RUNTIME_PROVIDER,
    model: PI_RUNTIME_MODEL,
    toolNames,
    modelsConfig: {
      providers: {
        [PI_RUNTIME_PROVIDER]: {
          baseUrl,
          api: 'openai-completions',
          apiKey: input.apiKey,
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsStore: false,
            supportsUsageInStreaming: true,
          },
          models: [
            {
              id: PI_RUNTIME_MODEL,
              name: 'ChatGPT Web Gateway E2E',
              reasoning: false,
              input: ['text'],
              contextWindow: 128_000,
              maxTokens: 32_768,
            },
          ],
        },
      },
    },
    extensionSource: extensionSource(),
    args: [
      '--provider',
      PI_RUNTIME_PROVIDER,
      '--model',
      PI_RUNTIME_MODEL,
      '--api-key',
      input.apiKey,
      '--no-session',
      '--mode',
      'text',
      '--print',
      '--extension',
      input.extensionPath,
      '--tools',
      toolNames.join(','),
      '--approve',
      `Reply exactly with ${input.token}. Do not use any tool.`,
    ],
  };
}

function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs ?? PI_RUNTIME_PROCESS_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export async function runPiBrowserRuntimeE2E(
  options: RunPiBrowserRuntimeE2EOptions,
): Promise<PiBrowserRuntimeE2EResult> {
  const dataDir = mkdtempSync(join(tmpdir(), 'cwg-pi-runtime-e2e-'));
  const piAgentDir = mkdtempSync(join(tmpdir(), 'cwg-real-pi-e2e-'));
  const profile = cloneRealE2EProfile(options.profileDir);
  const calls: DriverCall[] = [];
  let runtime: GatewayRuntime | undefined;

  try {
    runtime = await createGatewayRuntime({
      config: loadConfig({
        GATEWAY_API_KEY: PI_RUNTIME_API_KEY,
        DATA_DIR: dataDir,
        MAX_ACTIVE_PAGES: '1',
        PAGE_IDLE_TIMEOUT_MINUTES: '30',
        ...(options.proxyServer ? { CHATGPT_PROXY_SERVER: options.proxyServer } : {}),
      }),
      browserProfileDir: profile.profileDir,
      driver: createRecordingDriver(calls),
      logger: true,
    });
    const baseUrl = await runtime.app.listen({ host: '127.0.0.1', port: 0 });
    const token = `PI_RUNTIME_${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
    const extensionPath = join(piAgentDir, 'pi-runtime-tools.mjs');
    const fixture = buildRealPiRuntimeFixture({
      gatewayBaseUrl: baseUrl,
      apiKey: PI_RUNTIME_API_KEY,
      token,
      extensionPath,
    });
    writeFileSync(
      join(piAgentDir, 'models.json'),
      `${JSON.stringify(fixture.modelsConfig, null, 2)}\n`,
    );
    writeFileSync(extensionPath, fixture.extensionSource);

    const noProxy = mergeLocalGatewayNoProxy(process.env.NO_PROXY ?? process.env.no_proxy);
    const piEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      PI_CODING_AGENT_DIR: piAgentDir,
      PI_OFFLINE: '1',
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    };
    const piBinary = process.env.PI_BINARY?.trim() || 'pi';
    const version = await runProcess(piBinary, ['--version'], {
      cwd: process.cwd(),
      env: piEnvironment,
      timeoutMs: 30_000,
    });
    assert.equal(version.timedOut, false, `Pi --version timed out: ${version.stderr}`);
    assert.equal(version.code, 0, `Pi --version failed: ${version.stderr}`);
    const piVersion = version.stdout.trim();
    assert.ok(piVersion.length > 0, 'Installed Pi did not report a version');

    const pi = await runProcess(piBinary, fixture.args, {
      cwd: process.cwd(),
      env: piEnvironment,
    });
    assert.equal(pi.timedOut, false, `Real Pi runtime E2E timed out: ${pi.stderr}`);
    assert.equal(pi.code, 0, `Real Pi runtime E2E failed: ${pi.stderr || pi.stdout}`);
    assert.equal(pi.stdout.trim(), token, `Unexpected real Pi output: ${pi.stdout}`);
    assert.equal(
      calls.length,
      1,
      `Expected one Gateway/ChatGPT request from Pi, got ${calls.length}`,
    );

    const prompt = calls[0]?.prompt;
    assert.ok(prompt, 'Expected the recording Driver to capture the real Pi Browser prompt');
    const promptUtf8Bytes = Buffer.byteLength(prompt);
    assert.ok(
      promptUtf8Bytes > LARGE_MULTILINE_PASTE_THRESHOLD_BYTES,
      `Expected real Pi Browser prompt > ${LARGE_MULTILINE_PASTE_THRESHOLD_BYTES} bytes, got ${promptUtf8Bytes}`,
    );
    for (const toolName of fixture.toolNames) {
      assert.match(prompt, new RegExp(`\\b${toolName}\\b`));
    }

    return {
      realPi: true,
      piVersion,
      piOutput: true,
      promptUtf8Bytes,
      declaredTools: 16,
      gatewayRequests: 1,
    };
  } finally {
    await runtime?.close();
    profile.cleanup();
    rmSync(piAgentDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}
