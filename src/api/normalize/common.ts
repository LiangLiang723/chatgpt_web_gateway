import { InvalidRequestError } from '../errors.js';
import { encodeNamespacedToolName, encodeResponsesCustomToolName } from '../tool-namespace.js';
import type {
  NormalizedAttachment,
  NormalizedContentPart,
  NormalizedStructuredOutput,
  NormalizedTool,
  NormalizedToolChoice,
} from '../normalized.js';

export interface NormalizationState {
  attachments: NormalizedAttachment[];
  ignoredParameters: string[];
  nextAttachmentNumber: number;
}

interface TextPart {
  type: 'text';
  text: string;
}

interface FunctionToolInput {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

interface ResponsesFunctionToolInput {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
  defer_loading?: boolean;
}

interface ResponsesCustomToolInput {
  type: 'custom';
  name: string;
  description?: string;
  format?: unknown;
  defer_loading?: boolean;
}

interface ResponsesNamespaceToolInput {
  type: 'namespace';
  name: string;
  description?: string;
  tools: Array<ResponsesFunctionToolInput | ResponsesCustomToolInput>;
}

interface ResponsesServerToolInput {
  type: 'web_search' | 'web_search_preview' | 'tool_search';
}

type ResponsesToolInput =
  | ResponsesFunctionToolInput
  | ResponsesCustomToolInput
  | ResponsesNamespaceToolInput
  | ResponsesServerToolInput;

interface FunctionToolChoiceInput {
  type: 'function';
  function: { name: string };
}

interface ResponsesFunctionToolChoiceInput {
  type: 'function';
  name: string;
}

interface JsonObjectFormatInput {
  type: 'json_object';
}

interface JsonSchemaFormatInput {
  type: 'json_schema';
  json_schema: {
    name: string;
    description?: string;
    schema: unknown;
    strict?: boolean;
  };
}

export function createNormalizationState(): NormalizationState {
  return { attachments: [], ignoredParameters: [], nextAttachmentNumber: 1 };
}

export function normalizeInstructionText(input: string | TextPart[]): string {
  if (typeof input === 'string') return input;
  return input.map((part) => part.text).join('\n');
}

export function normalizeTools(input: FunctionToolInput[] | undefined): NormalizedTool[] {
  if (!input) return [];
  return input.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    ...(tool.function.description === undefined ? {} : { description: tool.function.description }),
    parameters: tool.function.parameters ?? {},
  }));
}

function customToolParameters(): Record<string, unknown> {
  return {
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input'],
    additionalProperties: false,
  };
}

export function normalizeResponsesTools(
  input: ResponsesToolInput[] | undefined,
  state?: NormalizationState,
): NormalizedTool[] {
  if (!input) return [];

  const normalized: NormalizedTool[] = [];
  for (const tool of input) {
    if (tool.type === 'function') {
      normalized.push({
        type: 'function',
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: tool.parameters ?? {},
      });
      continue;
    }

    if (tool.type === 'custom') {
      normalized.push({
        type: 'function',
        name: encodeResponsesCustomToolName(tool.name),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: customToolParameters(),
      });
      continue;
    }

    if (tool.type === 'namespace') {
      for (const child of tool.tools) {
        if (child.type === 'custom') {
          normalized.push({
            type: 'function',
            name: encodeResponsesCustomToolName(child.name, tool.name),
            description:
              child.description ??
              (tool.description === undefined ? child.name : `${tool.description} / ${child.name}`),
            parameters: customToolParameters(),
          });
          continue;
        }
        normalized.push({
          type: 'function',
          name: encodeNamespacedToolName(tool.name, child.name),
          description:
            child.description ??
            (tool.description === undefined ? child.name : `${tool.description} / ${child.name}`),
          parameters: child.parameters ?? {},
        });
      }
      continue;
    }

    const ignored = `tools.${tool.type}`;
    if (state !== undefined && !state.ignoredParameters.includes(ignored)) {
      state.ignoredParameters.push(ignored);
    }
  }
  return normalized;
}

export function normalizeToolChoice(
  input: 'auto' | 'none' | 'required' | FunctionToolChoiceInput | undefined,
): NormalizedToolChoice {
  if (input === undefined || input === 'auto') return { mode: 'auto' };
  if (input === 'none' || input === 'required') return { mode: input };
  return { mode: 'function', name: input.function.name };
}

export function normalizeResponsesToolChoice(
  input: 'auto' | 'none' | 'required' | ResponsesFunctionToolChoiceInput | undefined,
): NormalizedToolChoice {
  if (input === undefined || input === 'auto') return { mode: 'auto' };
  if (input === 'none' || input === 'required') return { mode: input };
  return { mode: 'function', name: input.name };
}

function nextAttachmentId(state: NormalizationState): string {
  const id = `attachment-${state.nextAttachmentNumber}`;
  state.nextAttachmentNumber += 1;
  return id;
}

export function addImageAttachment(
  state: NormalizationState,
  value: string,
): NormalizedContentPart {
  const id = nextAttachmentId(state);
  const source = value.startsWith('data:')
    ? ({ type: 'data_url', dataUrl: value } as const)
    : ({ type: 'url', url: value } as const);
  state.attachments.push({ id, kind: 'image', source });
  return { type: 'attachment', attachmentId: id };
}

export function addImageFileIdAttachment(
  state: NormalizationState,
  fileId: string,
): NormalizedContentPart {
  const id = nextAttachmentId(state);
  state.attachments.push({ id, kind: 'image', source: { type: 'file_id', fileId } });
  return { type: 'attachment', attachmentId: id };
}

export function addFileIdAttachment(
  state: NormalizationState,
  fileId: string,
): NormalizedContentPart {
  const id = nextAttachmentId(state);
  state.attachments.push({ id, kind: 'file', source: { type: 'file_id', fileId } });
  return { type: 'attachment', attachmentId: id };
}

export function addBase64FileAttachment(
  state: NormalizationState,
  data: string,
  filename?: string,
): NormalizedContentPart {
  const id = nextAttachmentId(state);
  state.attachments.push({
    id,
    kind: 'file',
    source: {
      type: 'base64',
      data,
      ...(filename === undefined ? {} : { filename }),
    },
  });
  return { type: 'attachment', attachmentId: id };
}

export function normalizeStructuredOutput(
  input: JsonObjectFormatInput | JsonSchemaFormatInput | undefined,
): NormalizedStructuredOutput | undefined {
  if (input === undefined) return undefined;
  if (input.type === 'json_object') return { type: 'json_object' };
  if (input.type === 'json_schema') {
    return {
      type: 'json_schema',
      name: input.json_schema.name,
      ...(input.json_schema.description === undefined
        ? {}
        : { description: input.json_schema.description }),
      schema: input.json_schema.schema,
      ...(input.json_schema.strict === undefined ? {} : { strict: input.json_schema.strict }),
    };
  }
  throw new InvalidRequestError('Unsupported structured output format', 'response_format');
}

export function normalizeResponsesStructuredOutput(
  input:
    | JsonObjectFormatInput
    | {
        type: 'json_schema';
        name: string;
        description?: string;
        schema: unknown;
        strict?: boolean;
      }
    | undefined,
): NormalizedStructuredOutput | undefined {
  if (input === undefined) return undefined;
  if (input.type === 'json_object') return { type: 'json_object' };
  return {
    type: 'json_schema',
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    schema: input.schema,
    ...(input.strict === undefined ? {} : { strict: input.strict }),
  };
}

export function recordIgnoredParameters(
  state: NormalizationState,
  input: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    if (input[field] !== undefined && !state.ignoredParameters.includes(field)) {
      state.ignoredParameters.push(field);
    }
  }
}
