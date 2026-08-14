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

export type NormalizedAttachment =
  | {
      id: string;
      kind: 'image';
      source:
        | { type: 'url'; url: string }
        | { type: 'data_url'; dataUrl: string }
        | { type: 'file_id'; fileId: string };
    }
  | {
      id: string;
      kind: 'file';
      source:
        { type: 'file_id'; fileId: string } | { type: 'base64'; data: string; filename?: string };
    };

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
