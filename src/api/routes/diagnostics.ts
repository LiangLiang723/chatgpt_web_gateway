import type { FastifyInstance } from 'fastify';

import type { RuntimeDiagnosticsProvider } from '../../diagnostics/runtime.js';

export function registerDiagnosticsRoute(
  app: FastifyInstance,
  diagnostics: RuntimeDiagnosticsProvider,
): void {
  app.get('/v1/diagnostics', async () => diagnostics.snapshot());
}
