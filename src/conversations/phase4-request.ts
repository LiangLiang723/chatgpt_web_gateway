import type { NormalizedMessage, NormalizedRequest } from '../api/normalized.js';

export type Phase4ExecutionErrorCode = 'unsupported_phase4_request';

export class Phase4ExecutionError extends Error {
  readonly code: Phase4ExecutionErrorCode;

  constructor(message: string) {
    super(message);
    this.name = 'Phase4ExecutionError';
    this.code = 'unsupported_phase4_request';
  }
}

function unsupported(message: string): never {
  throw new Phase4ExecutionError(message);
}

function textFromMessage(message: NormalizedMessage): string {
  if (message.role === 'tool') unsupported('Tool messages are not available in Phase 4');
  if (message.toolCallId !== undefined || (message.toolCalls?.length ?? 0) > 0) {
    unsupported('Tool calls are not available in Phase 4');
  }
  if (message.content.some((part) => part.type !== 'text')) {
    unsupported('Attachment content parts are not available in Phase 4');
  }
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

export function validatePhase4Request(request: NormalizedRequest): void {
  if (request.output.mode !== 'text') unsupported('Image output is not available in Phase 4');
  if (request.output.stream) unsupported('Streaming is not available in Phase 4');
  if (request.output.structured !== undefined) {
    unsupported('Structured output execution is not available in Phase 4');
  }
  if (request.attachments.length > 0) unsupported('Attachments are not available in Phase 4');
  if (request.tools.length > 0) unsupported('Tools are not available in Phase 4');
  if (request.toolChoice.mode !== 'auto') unsupported('Tool choice is not available in Phase 4');

  for (const message of request.messages) textFromMessage(message);

  const finalMessage = request.messages.at(-1);
  if (!finalMessage || finalMessage.role !== 'user') {
    unsupported('Phase 4 requires a final user message');
  }
  if (textFromMessage(finalMessage).trim().length === 0) {
    unsupported('Phase 4 final user text must be non-empty');
  }
}

export function buildFullContextPrompt(request: NormalizedRequest): string {
  validatePhase4Request(request);
  const payload = {
    system: request.instructions
      .filter((instruction) => instruction.role === 'system')
      .map((instruction) => instruction.content),
    developer: request.instructions
      .filter((instruction) => instruction.role === 'developer')
      .map((instruction) => instruction.content),
    messages: request.messages.map((message) => ({
      role: message.role,
      text: textFromMessage(message),
    })),
  };

  return [
    'You are processing an API request through ChatGPT Web Gateway.',
    'Treat the JSON below as the complete effective conversation context for this request.',
    'System instructions have priority over developer instructions;',
    'developer instructions have priority over conversation messages.',
    'Continue from that context and answer the final user message.',
    '',
    JSON.stringify(payload),
  ].join('\n');
}

export function buildAppendPrompt(message: NormalizedMessage): string {
  if (message.role !== 'user') unsupported('Phase 4 append requires one user message');
  const text = textFromMessage(message);
  if (text.trim().length === 0) unsupported('Phase 4 append user text must be non-empty');

  return [
    'Continue the existing conversation with the following next user message.',
    '',
    JSON.stringify({ user: text }),
  ].join('\n');
}
