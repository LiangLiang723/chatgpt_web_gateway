import type { NormalizedExecutionHandler } from '../api/execution.js';
import type { NormalizedRequest } from '../api/normalized.js';
import type { PagePool } from '../browser/types.js';
import type { ChatGptDriver } from '../chatgpt/driver.js';

export type Phase3ExecutionErrorCode =
  'conversation_sync_not_implemented' | 'unsupported_phase3_request';

export class Phase3ExecutionError extends Error {
  constructor(
    readonly code: Phase3ExecutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'Phase3ExecutionError';
  }
}

export interface Phase3TextExecutionResult {
  type: 'text';
  text: string;
  conversationUrl: string;
  completedAt: number;
}

export interface CreatePhase3ExecutorOptions {
  pagePool: Pick<PagePool, 'acquire'>;
  driver: ChatGptDriver;
  now?: () => number;
}

function syncError(message: string): never {
  throw new Phase3ExecutionError('conversation_sync_not_implemented', message);
}

function unsupported(message: string): never {
  throw new Phase3ExecutionError('unsupported_phase3_request', message);
}

function validatePhase3Request(request: NormalizedRequest): void {
  if (request.conversationKey !== undefined) syncError('Conversation key requires Phase 4');

  const userMessages = request.messages.filter((message) => message.role === 'user');
  const historyMessages = request.messages.filter((message) => message.role !== 'user');
  if (historyMessages.length > 0) syncError('Conversation history requires Phase 4');
  if (userMessages.length > 1) syncError('Multiple user turns require Phase 4');
  if (userMessages.length !== 1) unsupported('Phase 3 requires exactly one user message');

  if (request.output.mode !== 'text') unsupported('Image output is not available in Phase 3');
  if (request.output.stream) unsupported('Streaming is not available in Phase 3');
  if (request.output.structured !== undefined) {
    unsupported('Structured output execution is not available in Phase 3');
  }
  if (request.attachments.length > 0) unsupported('Attachments are not available in Phase 3');
  if (request.tools.length > 0) unsupported('Tools are not available in Phase 3');
  if (request.toolChoice.mode !== 'auto') unsupported('Tool choice is not available in Phase 3');

  const user = userMessages[0]!;
  if (user.content.some((part) => part.type !== 'text')) {
    unsupported('Attachment content parts are not available in Phase 3');
  }
  const text = user.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  if (text.trim().length === 0) unsupported('Phase 3 user text must be non-empty');
}

export function buildPhase3Prompt(request: NormalizedRequest): string {
  validatePhase3Request(request);
  const user = request.messages[0]!;
  const payload = {
    system: request.instructions
      .filter((instruction) => instruction.role === 'system')
      .map((instruction) => instruction.content),
    developer: request.instructions
      .filter((instruction) => instruction.role === 'developer')
      .map((instruction) => instruction.content),
    user: user.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n'),
  };

  return [
    'You are processing an API request through ChatGPT Web Gateway.',
    'Interpret the following JSON fields by their declared roles.',
    'System instructions have priority over developer instructions;',
    'developer instructions have priority over the user message.',
    '',
    JSON.stringify(payload),
  ].join('\n');
}

export function createPhase3Executor(
  options: CreatePhase3ExecutorOptions,
): NormalizedExecutionHandler {
  const now = options.now ?? Date.now;
  return async (request) => {
    const prompt = buildPhase3Prompt(request);
    const lease = await options.pagePool.acquire();
    try {
      const result = await options.driver.sendText(lease.page, {
        prompt,
        target: { kind: 'fresh' },
      });
      return {
        type: 'text',
        text: result.text,
        conversationUrl: result.conversationUrl,
        completedAt: now(),
      } satisfies Phase3TextExecutionResult;
    } finally {
      await lease.release();
    }
  };
}
