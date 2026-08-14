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
