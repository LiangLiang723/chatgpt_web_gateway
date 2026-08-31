import { Type } from 'typebox';
import type { Static } from 'typebox';

import {
  ChatResponseFormatSchema,
  DetailSchema,
  FunctionToolSchema,
  ToolChoiceSchema,
} from './common.js';

const TextPartSchema = Type.Object(
  {
    type: Type.Literal('text'),
    text: Type.String(),
  },
  { additionalProperties: false },
);

const ImageUrlPartSchema = Type.Object(
  {
    type: Type.Literal('image_url'),
    image_url: Type.Object(
      {
        url: Type.String({ minLength: 1 }),
        detail: Type.Optional(DetailSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const FileIdPartSchema = Type.Object(
  {
    type: Type.Literal('file'),
    file: Type.Object(
      {
        file_id: Type.String({ minLength: 1 }),
        filename: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const FileDataPartSchema = Type.Object(
  {
    type: Type.Literal('file'),
    file: Type.Object(
      {
        file_data: Type.String({ minLength: 1 }),
        filename: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const InstructionContentSchema = Type.Union([
  Type.String(),
  Type.Array(TextPartSchema, { minItems: 1 }),
]);

const UserContentSchema = Type.Union([
  Type.String(),
  Type.Array(
    Type.Union([TextPartSchema, ImageUrlPartSchema, FileIdPartSchema, FileDataPartSchema]),
    {
      minItems: 1,
    },
  ),
]);

const AssistantToolCallSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    type: Type.Literal('function'),
    function: Type.Object(
      {
        name: Type.String({ minLength: 1 }),
        arguments: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const StreamOptionsSchema = Type.Object(
  {
    include_usage: Type.Optional(Type.Unsafe<boolean>({ enum: [true, false] })),
  },
  { additionalProperties: false },
);

const SystemMessageSchema = Type.Object(
  {
    role: Type.Literal('system'),
    content: InstructionContentSchema,
  },
  { additionalProperties: false },
);

const DeveloperMessageSchema = Type.Object(
  {
    role: Type.Literal('developer'),
    content: InstructionContentSchema,
  },
  { additionalProperties: false },
);

const UserMessageSchema = Type.Object(
  {
    role: Type.Literal('user'),
    content: UserContentSchema,
  },
  { additionalProperties: false },
);

const AssistantMessageSchema = Type.Object(
  {
    role: Type.Literal('assistant'),
    content: Type.Optional(
      Type.Union([Type.String(), Type.Null(), Type.Array(TextPartSchema, { minItems: 1 })]),
    ),
    tool_calls: Type.Optional(Type.Array(AssistantToolCallSchema, { minItems: 1 })),
  },
  { additionalProperties: false },
);

const ToolMessageSchema = Type.Object(
  {
    role: Type.Literal('tool'),
    content: InstructionContentSchema,
    tool_call_id: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ChatCompletionsRequestSchema = Type.Object(
  {
    model: Type.String({ minLength: 1 }),
    messages: Type.Array(
      Type.Union([
        SystemMessageSchema,
        DeveloperMessageSchema,
        UserMessageSchema,
        AssistantMessageSchema,
        ToolMessageSchema,
      ]),
      { minItems: 1 },
    ),
    tools: Type.Optional(Type.Array(FunctionToolSchema)),
    tool_choice: Type.Optional(ToolChoiceSchema),
    response_format: Type.Optional(ChatResponseFormatSchema),
    stream: Type.Optional(Type.Boolean()),
    stream_options: Type.Optional(StreamOptionsSchema),
    temperature: Type.Optional(Type.Number()),
    top_p: Type.Optional(Type.Number()),
    presence_penalty: Type.Optional(Type.Number()),
    frequency_penalty: Type.Optional(Type.Number()),
    seed: Type.Optional(Type.Integer()),
    max_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
    max_completion_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
    logprobs: Type.Optional(Type.Unknown()),
    logit_bias: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export type ChatCompletionsRequest = Static<typeof ChatCompletionsRequestSchema>;
