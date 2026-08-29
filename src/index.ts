import { loadConfig } from './config/index.js';
import { createGatewayRuntime, type GatewayRuntime } from './runtime.js';

const config = loadConfig();
const runtimeHolder: { current?: GatewayRuntime } = {};
let shuttingDown = false;
let browserFatalBeforeReady = false;

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (runtimeHolder.current) {
    runtimeHolder.current.app.log.info({ reason, exitCode }, 'Shutting down Gateway');
    await runtimeHolder.current.close();
  }
  process.exitCode = exitCode;
}

const onBrowserFatal = (): void => {
  if (shuttingDown) return;
  if (!runtimeHolder.current) {
    browserFatalBeforeReady = true;
    process.exitCode = 1;
    return;
  }
  runtimeHolder.current.app.log.error(
    'Persistent Chromium context closed unexpectedly; exiting for container restart',
  );
  void shutdown('browser_context_closed', 1);
};

runtimeHolder.current = await createGatewayRuntime({ config, logger: true, onBrowserFatal });
const runtime = runtimeHolder.current;

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

if (browserFatalBeforeReady) {
  await shutdown('browser_context_closed_before_ready', 1);
} else {
  try {
    await runtime.app.listen({ host: config.host, port: config.port });
    runtime.app.log.info({ host: config.host, port: config.port }, 'Gateway listening');
  } catch (error) {
    await shutdown('listen_failed', 1);
    throw error;
  }
}
