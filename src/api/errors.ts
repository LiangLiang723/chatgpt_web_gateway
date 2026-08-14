export type OpenAIErrorType = 'authentication_error' | 'invalid_request_error' | 'server_error';

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: OpenAIErrorType;
    param: string | null;
    code: string | null;
  };
}

export class GatewayError extends Error {
  readonly statusCode: number;
  readonly type: OpenAIErrorType;
  readonly code: string | null;
  readonly param: string | null;

  constructor(options: {
    message: string;
    statusCode: number;
    type: OpenAIErrorType;
    code?: string | null;
    param?: string | null;
  }) {
    super(options.message);
    this.name = new.target.name;
    this.statusCode = options.statusCode;
    this.type = options.type;
    this.code = options.code ?? null;
    this.param = options.param ?? null;
  }
}

export class AuthenticationError extends GatewayError {
  constructor(message = 'Authentication failed') {
    super({
      message,
      statusCode: 401,
      type: 'authentication_error',
      code: 'invalid_api_key',
    });
  }
}

export class ValidationError extends GatewayError {
  constructor(message: string, param: string | null = null) {
    super({
      message,
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_request',
      param,
    });
  }
}

export class UnsupportedParameterError extends GatewayError {
  constructor(param: string, message = `Unsupported parameter: ${param}`) {
    super({
      message,
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'unsupported_parameter',
      param,
    });
  }
}

export class InvalidRequestError extends GatewayError {
  constructor(message: string, param: string | null = null) {
    super({
      message,
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_request',
      param,
    });
  }
}

export class BackendNotImplementedError extends GatewayError {
  constructor() {
    super({
      message: 'ChatGPT execution is not implemented in Phase 1',
      statusCode: 501,
      type: 'server_error',
      code: 'backend_not_implemented',
    });
  }
}

export function toOpenAIErrorBody(error: GatewayError): OpenAIErrorBody {
  return {
    error: {
      message: error.message,
      type: error.type,
      param: error.param,
      code: error.code,
    },
  };
}
