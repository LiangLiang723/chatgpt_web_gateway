export type ContextInstruction = {
  role: 'system' | 'developer';
  content: string;
};

export type ContextContentPart =
  { type: 'text'; text: string } | { type: 'attachment'; attachmentId: string };

export interface ContextToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ContextMessage {
  role: 'user' | 'assistant' | 'tool';
  content: ContextContentPart[];
  toolCallId?: string;
  toolCalls?: ContextToolCall[];
}

export type ContextSyncMode = 'FRESH' | 'APPEND' | 'RESTORE' | 'REBUILD';

export interface PersistedContextSnapshot {
  instructions: ContextInstruction[];
  messages: ContextMessage[];
  conversationUrl?: string;
}

export interface ContextSyncPlan {
  mode: ContextSyncMode;
  appendMessages: ContextMessage[];
}

export interface PlanContextSyncOptions {
  instructions: ContextInstruction[];
  messages: ContextMessage[];
  persisted?: PersistedContextSnapshot;
  hasWarmPage: boolean;
}

function contentPartEqual(left: ContextContentPart, right: ContextContentPart): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'text' && right.type === 'text') return left.text === right.text;
  return (
    left.type === 'attachment' &&
    right.type === 'attachment' &&
    left.attachmentId === right.attachmentId
  );
}

function toolCallEqual(left: ContextToolCall, right: ContextToolCall): boolean {
  return left.id === right.id && left.name === right.name && left.arguments === right.arguments;
}

function messageEqual(left: ContextMessage, right: ContextMessage): boolean {
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

function instructionsEqual(left: ContextInstruction[], right: ContextInstruction[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (instruction, index) =>
        instruction.role === right[index]!.role && instruction.content === right[index]!.content,
    )
  );
}

function hasPersistedPrefix(current: ContextMessage[], persisted: ContextMessage[]): boolean {
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

  if (options.hasWarmPage && options.persisted.conversationUrl) {
    return { mode: 'APPEND', appendMessages };
  }
  if (options.persisted.conversationUrl) return { mode: 'RESTORE', appendMessages };
  return { mode: 'REBUILD', appendMessages: [] };
}
