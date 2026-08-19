import type { AttachmentDescriptor } from '../attachments/types.js';

export type NormalizedInstructionRole = 'system' | 'developer';

export interface NormalizedInstruction {
  role: NormalizedInstructionRole;
  content: string;
}

export type NormalizedContentPart =
  { type: 'text'; text: string } | { type: 'attachment'; attachmentId: string };

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface NormalizedMessage {
  role: 'user' | 'assistant' | 'tool';
  content: NormalizedContentPart[];
  toolCallId?: string;
  toolCalls?: NormalizedToolCall[];
}

export interface NormalizedTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export type NormalizedToolChoice =
  { mode: 'auto' | 'none' | 'required' } | { mode: 'function'; name: string };

export type NormalizedAttachment = AttachmentDescriptor;

export type NormalizedStructuredOutput =
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      name: string;
      description?: string;
      schema: unknown;
      strict?: boolean;
    };

export interface NormalizedRequest {
  requestId: string;
  conversationKey?: string;
  instructions: NormalizedInstruction[];
  messages: NormalizedMessage[];
  tools: NormalizedTool[];
  toolChoice: NormalizedToolChoice;
  attachments: NormalizedAttachment[];
  output: {
    mode: 'text' | 'image';
    stream: boolean;
    structured?: NormalizedStructuredOutput;
  };
  diagnostics: {
    ignoredParameters: string[];
  };
}
