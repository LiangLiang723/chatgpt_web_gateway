import { Type } from 'typebox';
import type { Static } from 'typebox';

import {
  DetailSchema,
  ResponsesFunctionToolSchema,
  ResponsesTextFormatSchema,
  ResponsesToolChoiceSchema,
} from './common.js';

const InputTextPartSchema = Type.Object(
  {
    type: Type.Literal('input_text'),
    text: Type.String(),
  },
  { additionalProperties: false },
);

const InputImageUrlPartSchema = Type.Object(
  {
    type: Type.Literal('input_image'),
    image_url: Type.String({ minLength: 1 }),
    detail: Type.Optional(DetailSchema),
  },
  { additionalProperties: false },
);

const InputImageFilePartSchema = Type.Object(
  {
    type: Type.Literal('input_image'),
    file_id: Type.String({ minLength: 1 }),
    detail: Type.Optional(DetailSchema),
  },
  { additionalProperties: false },
);

const InputFileIdPartSchema = Type.Object(
  {
    type: Type.Literal('input_file'),
    file_id: Type.String({ minLength: 1 }),
    filename: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const InputFileDataPartSchema = Type.Object(
  {
    type: Type.Literal('input_file'),
    file_data: Type.String({ minLength: 1 }),
    filename: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const ResponsesContentPartSchema = Type.Union([
  InputTextPartSchema,
  InputImageUrlPartSchema,
  InputImageFilePartSchema,
  InputFileIdPartSchema,
  InputFileDataPartSchema,
]);

const ResponsesMessageSchema = Type.Object(
  {
    role: Type.Union([
      Type.Literal('system'),
      Type.Literal('developer'),
      Type.Literal('user'),
      Type.Literal('assistant'),
    ]),
    content: Type.Union([Type.Array(ResponsesContentPartSchema, { minItems: 1 }), Type.String()]),
  },
  { additionalProperties: false },
);

const FunctionCallInputSchema = Type.Object(
  {
    type: Type.Literal('function_call'),
    call_id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    arguments: Type.String(),
  },
  { additionalProperties: false },
);

const FunctionCallOutputSchema = Type.Object(
  {
    type: Type.Literal('function_call_output'),
    call_id: Type.String({ minLength: 1 }),
    output: Type.String(),
  },
  { additionalProperties: false },
);

export const ResponsesRequestSchema = Type.Object(
  {
    model: Type.String({ minLength: 1 }),
    instructions: Type.Optional(Type.String()),
    input: Type.Union([
      Type.Array(
        Type.Union([ResponsesMessageSchema, FunctionCallInputSchema, FunctionCallOutputSchema]),
        { minItems: 1 },
      ),
      Type.String(),
    ]),
    tools: Type.Optional(Type.Array(ResponsesFunctionToolSchema)),
    tool_choice: Type.Optional(ResponsesToolChoiceSchema),
    text: Type.Optional(
      Type.Object(
        {
          format: Type.Optional(ResponsesTextFormatSchema),
        },
        { additionalProperties: false },
      ),
    ),
    stream: Type.Optional(Type.Boolean()),
    temperature: Type.Optional(Type.Number()),
    top_p: Type.Optional(Type.Number()),
    seed: Type.Optional(Type.Integer()),
    max_output_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
    logprobs: Type.Optional(Type.Unknown()),
    logit_bias: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export type ResponsesRequest = Static<typeof ResponsesRequestSchema>;
