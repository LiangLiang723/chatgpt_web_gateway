import { loadConfig } from './config/index.js';
import { createGatewayRuntime } from './runtime.js';

const config = loadConfig();
const runtime = createGatewayRuntime({ config, logger: true });

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  runtime.app.log.info({ signal }, 'Shutting down Gateway');
  await runtime.close();
}

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

try {
  await runtime.app.listen({ host: config.host, port: config.port });
  runtime.app.log.info({ host: config.host, port: config.port }, 'Gateway listening');
} catch (error) {
  await runtime.close();
  throw error;
}
