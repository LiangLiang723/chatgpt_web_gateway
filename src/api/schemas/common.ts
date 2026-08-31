import { Type } from 'typebox';

export const DetailSchema = Type.Union([
  Type.Literal('auto'),
  Type.Literal('low'),
  Type.Literal('high'),
]);

export const FunctionToolSchema = Type.Object(
  {
    type: Type.Literal('function'),
    function: Type.Object(
      {
        name: Type.String({ minLength: 1 }),
        description: Type.Optional(Type.String()),
        parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        strict: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ResponsesFunctionToolSchema = Type.Object(
  {
    type: Type.Literal('function'),
    name: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    strict: Type.Optional(Type.Boolean()),
    defer_loading: Type.Optional(Type.Boolean()),
    output_schema: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ResponsesCustomToolSchema = Type.Object(
  {
    type: Type.Literal('custom'),
    name: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    format: Type.Optional(Type.Unknown()),
    defer_loading: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ResponsesNamespaceToolSchema = Type.Object(
  {
    type: Type.Literal('namespace'),
    name: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    tools: Type.Array(Type.Union([ResponsesFunctionToolSchema, ResponsesCustomToolSchema]), {
      minItems: 1,
    }),
  },
  { additionalProperties: false },
);

export const ResponsesToolSearchSchema = Type.Object(
  {
    type: Type.Literal('tool_search'),
    execution: Type.String({ minLength: 1 }),
    description: Type.String(),
    parameters: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const ResponsesWebSearchToolSchema = Type.Object(
  {
    type: Type.Union([Type.Literal('web_search'), Type.Literal('web_search_preview')]),
    external_web_access: Type.Optional(Type.Boolean()),
    indexed_web_access: Type.Optional(Type.Boolean()),
    search_context_size: Type.Optional(Type.String()),
    search_content_types: Type.Optional(Type.Array(Type.String())),
    user_location: Type.Optional(Type.Unknown()),
    filters: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const FunctionToolChoiceSchema = Type.Object(
  {
    type: Type.Literal('function'),
    function: Type.Object(
      {
        name: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ToolChoiceSchema = Type.Union([
  Type.Literal('auto'),
  Type.Literal('none'),
  Type.Literal('required'),
  FunctionToolChoiceSchema,
]);

export const ResponsesToolChoiceSchema = Type.Union([
  Type.Literal('auto'),
  Type.Literal('none'),
  Type.Literal('required'),
  Type.Object(
    {
      type: Type.Literal('function'),
      name: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export const ChatResponseFormatSchema = Type.Union([
  Type.Object({ type: Type.Literal('json_object') }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal('json_schema'),
      json_schema: Type.Object(
        {
          name: Type.String({ minLength: 1 }),
          description: Type.Optional(Type.String()),
          schema: Type.Unknown(),
          strict: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);

export const ResponsesTextFormatSchema = Type.Union([
  Type.Object({ type: Type.Literal('json_object') }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal('json_schema'),
      name: Type.String({ minLength: 1 }),
      description: Type.Optional(Type.String()),
      schema: Type.Unknown(),
      strict: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
]);
