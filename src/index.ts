import { buildServer } from './api/server.js';
import { loadConfig } from './config/index.js';

const config = loadConfig();
const app = buildServer({ config, logger: true });

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'Shutting down Gateway');
  await app.close();
}

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

await app.listen({ host: config.host, port: config.port });
app.log.info({ host: config.host, port: config.port }, 'Gateway listening');
