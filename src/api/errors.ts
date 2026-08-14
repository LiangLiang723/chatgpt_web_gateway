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
      message: 'ChatGPT execution backend is not configured',
      statusCode: 501,
      type: 'server_error',
      code: 'backend_not_implemented',
    });
  }
}

const executionErrorMap = {
  auth_required: {
    statusCode: 503,
    message: 'ChatGPT authentication is required',
  },
  browser_unavailable: {
    statusCode: 503,
    message: 'ChatGPT browser runtime is unavailable',
  },
  browser_maintenance_mode: {
    statusCode: 503,
    message: 'ChatGPT browser execution is unavailable during maintenance mode',
  },
  page_capacity_exceeded: {
    statusCode: 503,
    message: 'ChatGPT page capacity is currently exhausted',
  },
  selector_missing: {
    statusCode: 502,
    message: 'ChatGPT page structure does not match the current selector registry',
  },
  selector_ambiguous: {
    statusCode: 502,
    message: 'ChatGPT page structure produced an ambiguous selector match',
  },
  chatgpt_generation_timeout: {
    statusCode: 504,
    message: 'ChatGPT generation did not complete before the timeout',
  },
  chatgpt_response_missing: {
    statusCode: 502,
    message: 'ChatGPT did not produce a readable Assistant response',
  },
  conversation_sync_not_implemented: {
    statusCode: 501,
    message: 'Conversation synchronization is not implemented in Phase 3',
  },
  unsupported_phase3_request: {
    statusCode: 501,
    message: 'This request requires a capability not implemented in Phase 3',
  },
} as const;

export type StableExecutionErrorCode = keyof typeof executionErrorMap;

function executionCodeFromUnknown(error: unknown): StableExecutionErrorCode | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' && code in executionErrorMap
    ? (code as StableExecutionErrorCode)
    : undefined;
}

export function gatewayErrorFromExecution(error: unknown): GatewayError | undefined {
  const code = executionCodeFromUnknown(error);
  if (!code) return undefined;
  const mapped = executionErrorMap[code];
  return new GatewayError({
    message: mapped.message,
    statusCode: mapped.statusCode,
    type: 'server_error',
    code,
  });
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
