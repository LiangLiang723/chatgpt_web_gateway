import Fastify from 'fastify';
import type { FastifyError } from 'fastify';

import type { AppConfig } from '../config/index.js';
import { authenticateBearer } from './auth.js';
import { GatewayError, ValidationError, toOpenAIErrorBody } from './errors.js';
import { backendNotImplementedExecution, type NormalizedExecutionHandler } from './execution.js';
import { registerChatCompletionsRoute } from './routes/chat-completions.js';
import { registerHealthRoute } from './routes/health.js';
import { registerModelsRoute } from './routes/models.js';
import { registerResponsesRoute } from './routes/responses.js';

export interface BuildServerOptions {
  config: AppConfig;
  execute?: NormalizedExecutionHandler;
  logger?: boolean;
}

function validationErrorFromFastify(error: FastifyError): ValidationError | undefined {
  if (!error.validation) return undefined;
  const first = error.validation[0];
  const path = first?.instancePath || first?.params?.missingProperty;
  return new ValidationError(error.message, typeof path === 'string' && path ? path : null);
}

export function buildServer(options: BuildServerOptions) {
  const app = Fastify({ logger: options.logger ?? false });

  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/v1/')) {
      authenticateBearer(request.headers.authorization, options.config.gatewayApiKey);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const gatewayError =
      error instanceof GatewayError ? error : validationErrorFromFastify(error as FastifyError);

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

  registerHealthRoute(app);
  registerModelsRoute(app);
  registerChatCompletionsRoute(app, execute);
  registerResponsesRoute(app, execute);

  return app;
}
