import { Ajv } from 'ajv';

import type { NormalizedStructuredOutput } from '../api/normalized.js';

export type StructuredOutputErrorCode =
  'invalid_conversation_request' | 'chatgpt_structured_output_invalid';

export class StructuredOutputError extends Error {
  constructor(
    readonly code: StructuredOutputErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'StructuredOutputError';
  }
}

function objectJson(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new StructuredOutputError(
      'chatgpt_structured_output_invalid',
      'ChatGPT structured output is not valid JSON',
      error,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StructuredOutputError(
      'chatgpt_structured_output_invalid',
      'ChatGPT structured output must be a JSON object',
    );
  }
  return parsed;
}

function schemaValidator(output: Extract<NormalizedStructuredOutput, { type: 'json_schema' }>) {
  try {
    const ajv = new Ajv({ allErrors: true, strict: false });
    return ajv.compile(output.schema as object | boolean);
  } catch (error) {
    throw new StructuredOutputError(
      'invalid_conversation_request',
      'Structured output JSON Schema is invalid',
      error,
    );
  }
}

export function validateStructuredOutputDefinition(
  output: NormalizedStructuredOutput | undefined,
): void {
  if (output?.type !== 'json_schema') return;
  schemaValidator(output);
}

export function validateStructuredAssistantText(
  text: string,
  output: NormalizedStructuredOutput | undefined,
): void {
  if (output === undefined) return;
  const parsed = objectJson(text);
  if (output.type !== 'json_schema') return;

  const validate = schemaValidator(output);
  if (!validate(parsed)) {
    throw new StructuredOutputError(
      'chatgpt_structured_output_invalid',
      'ChatGPT structured output does not match the requested JSON Schema',
    );
  }
}

export function buildStructuredOutputPolicy(
  output: NormalizedStructuredOutput | undefined,
): Record<string, unknown> | undefined {
  if (output === undefined) return undefined;
  if (output.type === 'json_object') {
    return {
      type: 'json_object',
      task: 'Return exactly one valid JSON object as the entire answer. Do not use Markdown fences or prose outside the JSON object.',
    };
  }
  return {
    type: 'json_schema',
    name: output.name,
    ...(output.description === undefined ? {} : { description: output.description }),
    schema: output.schema,
    ...(output.strict === undefined ? {} : { strict: output.strict }),
    task: 'Return exactly one valid JSON object matching this schema as the entire answer. Do not use Markdown fences or prose outside the JSON object.',
  };
}
