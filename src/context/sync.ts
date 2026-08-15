import type {
  NormalizedContentPart,
  NormalizedInstruction,
  NormalizedMessage,
  NormalizedToolCall,
} from '../api/normalized.js';

export type ContextSyncMode = 'FRESH' | 'APPEND' | 'RESTORE' | 'REBUILD';

export interface PersistedContextSnapshot {
  instructions: NormalizedInstruction[];
  messages: NormalizedMessage[];
  conversationUrl?: string;
}

export interface ContextSyncPlan {
  mode: ContextSyncMode;
  appendMessages: NormalizedMessage[];
}

export interface PlanContextSyncOptions {
  instructions: NormalizedInstruction[];
  messages: NormalizedMessage[];
  persisted?: PersistedContextSnapshot;
  hasWarmPage: boolean;
}

function contentPartEqual(left: NormalizedContentPart, right: NormalizedContentPart): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'text' && right.type === 'text') return left.text === right.text;
  return (
    left.type === 'attachment' &&
    right.type === 'attachment' &&
    left.attachmentId === right.attachmentId
  );
}

function toolCallEqual(left: NormalizedToolCall, right: NormalizedToolCall): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.arguments === right.arguments
  );
}

function messageEqual(left: NormalizedMessage, right: NormalizedMessage): boolean {
  if (left.role !== right.role || left.toolCallId !== right.toolCallId) return false;
  if (left.content.length !== right.content.length) return false;
  if (!left.content.every((part, index) => contentPartEqual(part, right.content[index]!))) {
    return false;
  }

  const leftCalls = left.toolCalls ?? [];
  const rightCalls = right.toolCalls ?? [];
  return (
    leftCalls.length === rightCalls.length &&
    leftCalls.every((call, index) => toolCallEqual(call, rightCalls[index]!))
  );
}

function instructionsEqual(
  left: NormalizedInstruction[],
  right: NormalizedInstruction[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (instruction, index) =>
        instruction.role === right[index]!.role &&
        instruction.content === right[index]!.content,
    )
  );
}

function hasPersistedPrefix(
  current: NormalizedMessage[],
  persisted: NormalizedMessage[],
): boolean {
  if (persisted.length > current.length) return false;
  return persisted.every((message, index) => messageEqual(message, current[index]!));
}

export function planContextSync(options: PlanContextSyncOptions): ContextSyncPlan {
  if (!options.persisted) return { mode: 'FRESH', appendMessages: [] };

  if (!instructionsEqual(options.instructions, options.persisted.instructions)) {
    return { mode: 'REBUILD', appendMessages: [] };
  }

  if (!hasPersistedPrefix(options.messages, options.persisted.messages)) {
    return { mode: 'REBUILD', appendMessages: [] };
  }

  const appendMessages = options.messages.slice(options.persisted.messages.length);
  if (appendMessages.length !== 1 || appendMessages[0]?.role !== 'user') {
    return { mode: 'REBUILD', appendMessages: [] };
  }

  if (options.hasWarmPage) return { mode: 'APPEND', appendMessages };
  if (options.persisted.conversationUrl) return { mode: 'RESTORE', appendMessages };
  return { mode: 'REBUILD', appendMessages: [] };
}
