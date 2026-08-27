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
  file_not_found: {
    statusCode: 404,
    type: 'invalid_request_error',
    message: 'File resource was not found',
  },
  invalid_file_upload: {
    statusCode: 400,
    type: 'invalid_request_error',
    message: 'The file upload request is invalid',
  },
  file_too_large: {
    statusCode: 413,
    type: 'invalid_request_error',
    message: 'The file exceeds the Gateway upload limit',
  },
  invalid_attachment: {
    statusCode: 400,
    type: 'invalid_request_error',
    message: 'The attachment input is invalid',
  },
  attachment_too_large: {
    statusCode: 413,
    type: 'invalid_request_error',
    message: 'The attachment input exceeds the Gateway limit',
  },
  attachment_fetch_failed: {
    statusCode: 400,
    type: 'invalid_request_error',
    message: 'The remote attachment could not be fetched safely',
  },
  chatgpt_upload_failed: {
    statusCode: 502,
    type: 'server_error',
    message: 'ChatGPT rejected or failed the attachment upload',
  },
  chatgpt_upload_timeout: {
    statusCode: 504,
    type: 'server_error',
    message: 'ChatGPT attachment upload did not become ready before the timeout',
  },
  file_storage_error: {
    statusCode: 500,
    type: 'server_error',
    message: 'Gateway file storage failed',
  },
  unsupported_phase7_request: {
    statusCode: 501,
    type: 'server_error',
    message: 'This request requires a capability not implemented in Phase 7',
  },
  chatgpt_tool_required: {
    statusCode: 502,
    type: 'server_error',
    message: 'ChatGPT did not produce a required tool call',
  },
  chatgpt_tool_protocol_invalid: {
    statusCode: 502,
    type: 'server_error',
    message: 'ChatGPT produced an invalid private tool protocol response',
  },
  chatgpt_tool_unknown: {
    statusCode: 502,
    type: 'server_error',
    message: 'ChatGPT requested an unknown tool',
  },
  chatgpt_tool_forbidden: {
    statusCode: 502,
    type: 'server_error',
    message: 'ChatGPT violated the current tool choice policy',
  },
  unsupported_phase6_request: {
    statusCode: 501,
    type: 'server_error',
    message: 'This request requires a capability not implemented in Phase 6',
  },
  auth_required: {
    statusCode: 503,
    type: 'server_error',
    message: 'ChatGPT authentication is required',
  },
  browser_unavailable: {
    statusCode: 503,
    type: 'server_error',
    message: 'ChatGPT browser runtime is unavailable',
  },
  browser_maintenance_mode: {
    statusCode: 503,
    type: 'server_error',
    message: 'ChatGPT browser execution is unavailable during maintenance mode',
  },
  page_capacity_exceeded: {
    statusCode: 503,
    type: 'server_error',
    message: 'ChatGPT page capacity is currently exhausted',
  },
  selector_missing: {
    statusCode: 502,
    type: 'server_error',
    message: 'ChatGPT page structure does not match the current selector registry',
  },
  selector_ambiguous: {
    statusCode: 502,
    type: 'server_error',
    message: 'ChatGPT page structure produced an ambiguous selector match',
  },
  chatgpt_generation_timeout: {
    statusCode: 504,
    type: 'server_error',
    message: 'ChatGPT generation did not complete before the timeout',
  },
  chatgpt_response_missing: {
    statusCode: 502,
    type: 'server_error',
    message: 'ChatGPT did not produce a readable Assistant response',
  },
  chatgpt_stream_diverged: {
    statusCode: 502,
    type: 'server_error',
    message: 'ChatGPT rewrote an Assistant prefix that was already streamed',
  },
  conversation_restore_failed: {
    statusCode: 502,
    type: 'server_error',
    message: 'The saved ChatGPT conversation could not be restored',
  },
  unsupported_phase5_request: {
    statusCode: 501,
    type: 'server_error',
    message: 'This request requires a capability not implemented in Phase 5',
  },
  unsupported_phase4_request: {
    statusCode: 501,
    type: 'server_error',
    message: 'This request requires a capability not implemented in Phase 4',
  },
  invalid_conversation_request: {
    statusCode: 400,
    type: 'invalid_request_error',
    message: 'The Conversation request is invalid',
  },
  conversation_sync_not_implemented: {
    statusCode: 501,
    type: 'server_error',
    message: 'Conversation synchronization is not implemented in Phase 3',
  },
  unsupported_phase3_request: {
    statusCode: 501,
    type: 'server_error',
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
  const rawCode =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (rawCode === 'FST_REQ_FILE_TOO_LARGE') {
    return new GatewayError({
      message: 'The file exceeds the Gateway upload limit',
      statusCode: 413,
      type: 'invalid_request_error',
      code: 'file_too_large',
    });
  }
  if (
    rawCode === 'FST_PARTS_LIMIT' ||
    rawCode === 'FST_FILES_LIMIT' ||
    rawCode === 'FST_FIELDS_LIMIT' ||
    rawCode === 'FST_INVALID_MULTIPART_CONTENT_TYPE'
  ) {
    return new GatewayError({
      message: 'The file upload request is invalid',
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_file_upload',
    });
  }

  const code = executionCodeFromUnknown(error);
  if (!code) return undefined;
  const mapped = executionErrorMap[code];
  return new GatewayError({
    message: mapped.message,
    statusCode: mapped.statusCode,
    type: mapped.type,
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
