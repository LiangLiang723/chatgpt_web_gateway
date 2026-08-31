import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import multipart from '@fastify/multipart';

import type { FileService } from '../attachments/file-service.js';
import { MAX_FILE_BYTES } from '../attachments/policy.js';
import type { AppConfig } from '../config/index.js';
import type { RuntimeDiagnosticsProvider } from '../diagnostics/runtime.js';
import type { ImageGenerationServiceLike } from '../images/service.js';
import { authenticateBearer } from './auth.js';
import {
  GatewayError,
  ValidationError,
  gatewayErrorFromExecution,
  toOpenAIErrorBody,
} from './errors.js';
import {
  backendNotImplementedExecution,
  backendNotImplementedStreamingExecution,
  type NormalizedExecutionHandler,
  type NormalizedStreamingExecutionHandler,
} from './execution.js';
import { registerChatCompletionsRoute } from './routes/chat-completions.js';
import { registerDiagnosticsRoute } from './routes/diagnostics.js';
import { registerFilesRoute } from './routes/files.js';
import { registerHealthRoute } from './routes/health.js';
import { registerImagesRoute } from './routes/images.js';
import { registerModelsRoute } from './routes/models.js';
import { registerResponsesRoute } from './routes/responses.js';

export interface BuildServerOptions {
  config: AppConfig;
  execute?: NormalizedExecutionHandler;
  stream?: NormalizedStreamingExecutionHandler;
  fileService?: FileService;
  imageService?: ImageGenerationServiceLike;
  diagnostics?: RuntimeDiagnosticsProvider;
  logger?: boolean;
}

function validationErrorFromFastify(error: FastifyError): ValidationError | undefined {
  if (!error.validation) return undefined;
  const first = error.validation[0];
  const path = first?.instancePath || first?.params?.missingProperty;
  return new ValidationError(error.message, typeof path === 'string' && path ? path : null);
}

export function buildServer(options: BuildServerOptions) {
  const app = Fastify({
    logger: options.logger ?? false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.register(multipart, {
    preservePath: true,
    throwFileSizeLimit: false,
    limits: {
      fileSize: MAX_FILE_BYTES + 1,
      files: 1,
      fields: 2,
      parts: 3,
    },
  });

  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/v1/')) {
      authenticateBearer(request.headers.authorization, options.config.gatewayApiKey);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const gatewayError =
      error instanceof GatewayError
        ? error
        : (validationErrorFromFastify(error as FastifyError) ?? gatewayErrorFromExecution(error));

    if (gatewayError) {
      return reply.status(gatewayError.statusCode).send(toOpenAIErrorBody(gatewayError));
    }

    request.log.error({ err: error }, 'Unhandled Gateway error');
    return reply.status(500).send({
      error: {
        message: 'Internal server error',
        type: 'server_error',
        param: null,
        code: 'internal_error',
      },
    });
  });

  const execute = options.execute ?? backendNotImplementedExecution;
  const stream = options.stream ?? backendNotImplementedStreamingExecution;

  registerHealthRoute(app);
  registerModelsRoute(app, options.config);
  if (options.diagnostics) registerDiagnosticsRoute(app, options.diagnostics);
  if (options.fileService) registerFilesRoute(app, options.fileService);
  if (options.imageService) registerImagesRoute(app, options.config, options.imageService);
  registerChatCompletionsRoute(app, execute, stream);
  registerResponsesRoute(app, execute, stream);

  return app;
}
