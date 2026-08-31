import { Type } from 'typebox';
import type { Static } from 'typebox';

import {
  DetailSchema,
  ResponsesCustomToolSchema,
  ResponsesFunctionToolSchema,
  ResponsesNamespaceToolSchema,
  ResponsesTextFormatSchema,
  ResponsesToolChoiceSchema,
  ResponsesToolSearchSchema,
  ResponsesWebSearchToolSchema,
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

const OutputTextPartSchema = Type.Object(
  {
    type: Type.Literal('output_text'),
    text: Type.String(),
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
  OutputTextPartSchema,
]);

const FunctionCallOutputContentPartSchema = Type.Union([
  InputTextPartSchema,
  InputImageUrlPartSchema,
  Type.Object(
    {
      type: Type.Literal('input_audio'),
      audio_url: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('encrypted_content'),
      encrypted_content: Type.String(),
    },
    { additionalProperties: false },
  ),
]);

const ResponsesMessageSchema = Type.Object(
  {
    type: Type.Optional(Type.Literal('message')),
    id: Type.Optional(Type.String({ minLength: 1 })),
    role: Type.Union([
      Type.Literal('system'),
      Type.Literal('developer'),
      Type.Literal('user'),
      Type.Literal('assistant'),
    ]),
    content: Type.Union([Type.Array(ResponsesContentPartSchema, { minItems: 1 }), Type.String()]),
    status: Type.Optional(Type.String()),
    phase: Type.Optional(Type.Unknown()),
    internal_chat_message_metadata_passthrough: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

const FunctionCallInputSchema = Type.Object(
  {
    type: Type.Literal('function_call'),
    id: Type.Optional(Type.String({ minLength: 1 })),
    call_id: Type.String({ minLength: 1 }),
    namespace: Type.Optional(Type.String({ minLength: 1 })),
    name: Type.String({ minLength: 1 }),
    arguments: Type.String(),
    status: Type.Optional(Type.String()),
    encrypted_function_args: Type.Optional(Type.Unknown()),
    internal_chat_message_metadata_passthrough: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

const CustomToolCallInputSchema = Type.Object(
  {
    type: Type.Literal('custom_tool_call'),
    id: Type.Optional(Type.String({ minLength: 1 })),
    call_id: Type.String({ minLength: 1 }),
    namespace: Type.Optional(Type.String({ minLength: 1 })),
    name: Type.String({ minLength: 1 }),
    input: Type.String(),
    status: Type.Optional(Type.String()),
    internal_chat_message_metadata_passthrough: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

const FunctionCallOutputSchema = Type.Object(
  {
    type: Type.Literal('function_call_output'),
    id: Type.Optional(Type.String({ minLength: 1 })),
    call_id: Type.String({ minLength: 1 }),
    output: Type.Union([
      Type.String(),
      Type.Array(FunctionCallOutputContentPartSchema, { minItems: 1 }),
    ]),
    internal_chat_message_metadata_passthrough: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

const CustomToolCallOutputSchema = Type.Object(
  {
    type: Type.Literal('custom_tool_call_output'),
    id: Type.Optional(Type.String({ minLength: 1 })),
    call_id: Type.String({ minLength: 1 }),
    output: Type.Union([
      Type.String(),
      Type.Array(FunctionCallOutputContentPartSchema, { minItems: 1 }),
    ]),
    internal_chat_message_metadata_passthrough: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ResponsesRequestSchema = Type.Object(
  {
    model: Type.String({ minLength: 1 }),
    instructions: Type.Optional(Type.String()),
    input: Type.Union([
      Type.Array(
        Type.Union([
          ResponsesMessageSchema,
          FunctionCallInputSchema,
          FunctionCallOutputSchema,
          CustomToolCallInputSchema,
          CustomToolCallOutputSchema,
        ]),
        { minItems: 1 },
      ),
      Type.String(),
    ]),
    tools: Type.Optional(
      Type.Array(
        Type.Union([
          ResponsesFunctionToolSchema,
          ResponsesCustomToolSchema,
          ResponsesNamespaceToolSchema,
          ResponsesWebSearchToolSchema,
          ResponsesToolSearchSchema,
        ]),
      ),
    ),
    tool_choice: Type.Optional(ResponsesToolChoiceSchema),
    text: Type.Optional(
      Type.Object(
        {
          format: Type.Optional(ResponsesTextFormatSchema),
          verbosity: Type.Optional(Type.Unknown()),
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
    parallel_tool_calls: Type.Optional(Type.Unknown()),
    reasoning: Type.Optional(Type.Unknown()),
    store: Type.Optional(Type.Unknown()),
    stream_options: Type.Optional(Type.Unknown()),
    include: Type.Optional(Type.Unknown()),
    service_tier: Type.Optional(Type.Unknown()),
    prompt_cache_key: Type.Optional(Type.Unknown()),
    prompt_cache_retention: Type.Optional(Type.Unknown()),
    client_metadata: Type.Optional(Type.Unknown()),
    background: Type.Optional(Type.Unknown()),
    metadata: Type.Optional(Type.Unknown()),
    user: Type.Optional(Type.Unknown()),
    previous_response_id: Type.Optional(Type.Unknown()),
    truncation: Type.Optional(Type.Unknown()),
    max_tool_calls: Type.Optional(Type.Unknown()),
    safety_identifier: Type.Optional(Type.Unknown()),
    top_logprobs: Type.Optional(Type.Unknown()),
    provider: Type.Optional(Type.Unknown()),
    providerOptions: Type.Optional(Type.Unknown()),
    extra_body: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export type ResponsesRequest = Static<typeof ResponsesRequestSchema>;
