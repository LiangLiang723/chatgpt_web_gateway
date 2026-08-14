import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { buildServer } from './api/server.js';
import type { AppConfig } from './config/index.js';
import { createPersistenceContext, type PersistenceContext } from './persistence/index.js';

export interface CreateGatewayRuntimeOptions {
  config: AppConfig;
  logger?: boolean;
  migrationsDir?: string;
}

export interface GatewayRuntime {
  readonly app: FastifyInstance;
  readonly persistence: PersistenceContext;
  close(): Promise<void>;
}

export function createGatewayRuntime(options: CreateGatewayRuntimeOptions): GatewayRuntime {
  const persistence = createPersistenceContext({
    databasePath: join(options.config.dataDir, 'gateway.db'),
    ...(options.migrationsDir === undefined ? {} : { migrationsDir: options.migrationsDir }),
  });

  let app: FastifyInstance;
  try {
    app = buildServer({ config: options.config, logger: options.logger ?? false });
  } catch (error) {
    persistence.close();
    throw error;
  }

  let closed = false;
  return {
    app,
    persistence,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await app.close();
      } finally {
        persistence.close();
      }
    },
  };
}
