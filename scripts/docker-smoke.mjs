import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const project = `cwg-smoke-${process.pid}`;
const dataPath = mkdtempSync(path.join(tmpdir(), 'cwg-smoke-'));
const gatewayPort = 39000 + (process.pid % 500);
const novncPort = 40000 + (process.pid % 500);
const puid = 12345;
const pgid = 12346;

const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  IMAGE_NAME: 'chatgpt-web-gateway:phase1',
  GATEWAY_API_KEY: 'smoke-api-key',
  GATEWAY_BIND: '127.0.0.1',
  HOST: '0.0.0.0',
  PORT: String(gatewayPort),
  DATA_PATH: dataPath,
  PUID: String(puid),
  PGID: String(pgid),
  NOVNC_BIND: '127.0.0.1',
  NOVNC_PORT: String(novncPort),
  NOVNC_PASSWORD: 'smoke-novnc-password',
  MAINTENANCE_URL: 'about:blank',
  CHATGPT_PROXY_SERVER: 'http://127.0.0.1:65534',
  CHATGPT_PROFILE_DIR: '/data/e2e-browser-profile',
};

function composeArgs(maintenance, ...args) {
  return [
    'compose',
    '-p',
    project,
    '-f',
    'compose.yaml',
    ...(maintenance ? ['-f', 'compose.novnc.yaml'] : []),
    ...args,
  ];
}

function runDocker(args, options = {}) {
  return execFileSync('docker', args, {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
  }).trim();
}

function commandSucceeds(args) {
  return (
    spawnSync('docker', args, {
      cwd: process.cwd(),
      env,
      stdio: 'ignore',
    }).status === 0
  );
}

function serviceConfig(maintenance) {
  const parsed = JSON.parse(
    runDocker(composeArgs(maintenance, 'config', '--format', 'json'), { quiet: true }),
  );
  const gateway = parsed.services?.gateway;
  if (!gateway) throw new Error('Compose config does not define the gateway service');
  return gateway;
}

function publishedTargets(service) {
  return (service.ports ?? []).map((port) => Number(port.target));
}

function publishedPort(service, target) {
  return (service.ports ?? []).find((port) => Number(port.target) === target);
}

async function waitForHealth() {
  const url = `http://127.0.0.1:${gatewayPort}/health`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch {
      // Container may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Gateway did not become healthy at ${url}`);
}

async function waitForNovnc() {
  const url = `http://127.0.0.1:${novncPort}/vnc.html`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch {
      // Maintenance stack may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`noVNC did not become reachable at ${url}`);
}

async function assertNovncRfbHandshake() {
  const url = `ws://127.0.0.1:${novncPort}/websockify`;
  const banner = await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out waiting for RFB banner from ${url}`));
    }, 3_000);

    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => {
      clearTimeout(timer);
      socket.close();
      resolve(Buffer.from(event.data).toString('utf8'));
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`noVNC WebSocket failed at ${url}`));
    });
  });

  if (!banner.startsWith('RFB 003.008')) {
    throw new Error(`Unexpected RFB banner from noVNC backend: ${JSON.stringify(banner)}`);
  }
}

async function assertHttpContract() {
  const modelsUrl = `http://127.0.0.1:${gatewayPort}/v1/models`;
  const unauthenticated = await fetch(modelsUrl);
  if (unauthenticated.status !== 401) {
    throw new Error(
      `Expected unauthenticated /v1/models to return 401, got ${unauthenticated.status}`,
    );
  }

  const authenticated = await fetch(modelsUrl, {
    headers: { authorization: 'Bearer smoke-api-key' },
  });
  if (authenticated.status !== 200) {
    throw new Error(`Expected authenticated /v1/models to return 200, got ${authenticated.status}`);
  }
  const body = await authenticated.json();
  if (body?.data?.[0]?.id !== 'chatgpt-web') {
    throw new Error('Authenticated /v1/models did not expose chatgpt-web');
  }
}

function containerId(maintenance) {
  const id = runDocker(composeArgs(maintenance, 'ps', '-q', 'gateway'), { quiet: true });
  if (!id) throw new Error('Gateway container is not running');
  return id;
}

function assertPersistence(id) {
  if (!commandSucceeds(['exec', id, 'test', '-f', '/data/gateway.db'])) {
    throw new Error('Gateway did not create /data/gateway.db');
  }

  const owner = runDocker(['exec', id, 'stat', '-c', '%u:%g', '/data/gateway.db'], { quiet: true });
  if (owner !== `${puid}:${pgid}`) {
    throw new Error(`Expected gateway.db owner ${puid}:${pgid}, got ${owner}`);
  }

  const migration = JSON.parse(
    runDocker(
      [
        'exec',
        '--user',
        `${puid}:${pgid}`,
        id,
        'node',
        '--input-type=module',
        '-e',
        "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync('/data/gateway.db',{readOnly:true}); const row=db.prepare('SELECT version,name,(SELECT COUNT(*) FROM schema_migrations) AS count FROM schema_migrations WHERE version=1').get(); db.close(); console.log(JSON.stringify(row));",
      ],
      { quiet: true },
    ),
  );
  if (migration?.version !== 1 || migration?.name !== 'initial' || migration?.count !== 1) {
    throw new Error(`Unexpected SQLite migration state: ${JSON.stringify(migration)}`);
  }
}

function assertRuntimeIdentity(id) {
  const nodeVersion = runDocker(['exec', id, 'node', '--version'], { quiet: true });
  if (!/^v24\./.test(nodeVersion)) {
    throw new Error(`Expected Node 24.x in the runtime image, got ${nodeVersion}`);
  }

  const identity = runDocker(
    [
      'exec',
      id,
      'sh',
      '-lc',
      "pid=$(pgrep -f '^node dist/index.js$' | head -n 1); test -n \"$pid\"; awk '/^Uid:/{print $2} /^Gid:/{print $2}' /proc/$pid/status",
    ],
    { quiet: true },
  ).split(/\s+/);
  if (identity[0] !== String(puid) || identity[1] !== String(pgid)) {
    throw new Error(`Expected Gateway to run as ${puid}:${pgid}, got ${identity.join(':')}`);
  }

  runDocker(
    [
      'exec',
      '--user',
      `${puid}:${pgid}`,
      id,
      'sh',
      '-lc',
      'touch /data/.gateway-smoke-write && rm /data/.gateway-smoke-write',
    ],
    { quiet: true },
  );
}

function browserProfileOwner(id, expectedProfileDir) {
  const processList = runDocker(['exec', id, 'ps', '-eo', 'pid=,args='], { quiet: true });
  const owners = processList
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter(
      (match) =>
        match?.[2]?.includes(`--user-data-dir=${expectedProfileDir}`) &&
        !match[2].includes(' --type='),
    );

  if (owners.length !== 1) {
    throw new Error(
      `Expected exactly one Chromium owner for ${expectedProfileDir}, got ${owners.length}`,
    );
  }
  return { pid: owners[0][1], args: owners[0][2] };
}

function assertBrowserMode(id, maintenance) {
  const expectedProfileDir = maintenance ? env.CHATGPT_PROFILE_DIR : '/data/browser-profile';
  const owner = browserProfileOwner(id, expectedProfileDir);
  const headless = owner.args.includes('--headless');
  if (headless) {
    throw new Error(
      `Expected full Chromium on a virtual display in ${maintenance ? 'maintenance' : 'normal'} mode, got: ${owner.args}`,
    );
  }
  if (!owner.args.includes(`--proxy-server=${env.CHATGPT_PROXY_SERVER}`)) {
    throw new Error(`Chromium did not receive CHATGPT_PROXY_SERVER: ${owner.args}`);
  }
  if (maintenance) {
    if (!owner.args.startsWith('/usr/bin/google-chrome ')) {
      throw new Error(`Maintenance browser must use Google Chrome Stable: ${owner.args}`);
    }
    if (owner.args.includes('--no-sandbox')) {
      throw new Error(
        `Maintenance Google Chrome must keep the Chromium sandbox enabled: ${owner.args}`,
      );
    }
    if (owner.args.includes('--remote-debugging-pipe')) {
      throw new Error(`Maintenance Google Chrome must not be Playwright-controlled: ${owner.args}`);
    }
    const chromeVersion = runDocker(['exec', id, 'google-chrome', '--version'], { quiet: true });
    if (chromeVersion !== 'Google Chrome 151.0.7922.137') {
      throw new Error(`Unexpected maintenance Google Chrome version: ${chromeVersion}`);
    }
    const securityStatus = runDocker(
      ['exec', id, 'sh', '-lc', `grep -E '^(CapEff|Seccomp):' /proc/${owner.pid}/status`],
      { quiet: true },
    );
    const capEff = securityStatus.match(/^CapEff:\s*([0-9a-f]+)$/m)?.[1];
    const seccomp = securityStatus.match(/^Seccomp:\s*(\d+)$/m)?.[1];
    if (!capEff || (BigInt(`0x${capEff}`) & (1n << 21n)) !== 0n) {
      throw new Error(
        `Maintenance Google Chrome must not receive CAP_SYS_ADMIN: ${securityStatus}`,
      );
    }
    if (seccomp !== '2') {
      throw new Error(
        `Maintenance Google Chrome must run under seccomp filtering: ${securityStatus}`,
      );
    }
  }

  const identity = runDocker(
    [
      'exec',
      id,
      'sh',
      '-lc',
      `awk '/^Uid:/{print $2} /^Gid:/{print $2}' /proc/${owner.pid}/status`,
    ],
    { quiet: true },
  ).split(/\s+/);
  if (identity[0] !== String(puid) || identity[1] !== String(pgid)) {
    throw new Error(`Chromium must run as ${puid}:${pgid}, got ${identity.join(':')}`);
  }
}

function assertMaintenanceProcesses(id, expected) {
  const xvfbPid = runDocker(['exec', id, 'pgrep', '-f', '^Xvfb '], { quiet: true }).split(/\s+/)[0];
  if (!xvfbPid) throw new Error('Xvfb must run in both normal and maintenance modes');
  const xvfbIdentity = runDocker(
    ['exec', id, 'sh', '-lc', `awk '/^Uid:/{print $2} /^Gid:/{print $2}' /proc/${xvfbPid}/status`],
    { quiet: true },
  ).split(/\s+/);
  if (xvfbIdentity[0] !== String(puid) || xvfbIdentity[1] !== String(pgid)) {
    throw new Error(`Xvfb must run as ${puid}:${pgid}, got ${xvfbIdentity.join(':')}`);
  }

  for (const pattern of ['x11vnc', 'websockify', 'maintenance-browser.mjs']) {
    const found = commandSucceeds(['exec', id, 'pgrep', '-f', pattern]);
    if (found !== expected) {
      throw new Error(
        `${pattern} process ${expected ? 'was not started in maintenance mode' : 'unexpectedly runs in normal mode'}`,
      );
    }
    if (expected) {
      const pid = runDocker(['exec', id, 'pgrep', '-f', pattern], { quiet: true }).split(/\s+/)[0];
      const identity = runDocker(
        ['exec', id, 'sh', '-lc', `awk '/^Uid:/{print $2} /^Gid:/{print $2}' /proc/${pid}/status`],
        { quiet: true },
      ).split(/\s+/);
      if (identity[0] !== String(puid) || identity[1] !== String(pgid)) {
        throw new Error(`${pattern} must run as ${puid}:${pgid}, got ${identity.join(':')}`);
      }
    }
  }

  if (expected) {
    const processList = runDocker(['exec', id, 'ps', '-eo', 'args='], { quiet: true });
    if (processList.includes(env.NOVNC_PASSWORD)) {
      throw new Error('noVNC password leaked into the process command line');
    }
  }
}

function down(maintenance) {
  spawnSync('docker', composeArgs(maintenance, 'down', '--remove-orphans'), {
    cwd: process.cwd(),
    env,
    stdio: 'ignore',
  });
}

function assertProfileUnlocked(profilePath) {
  if (!existsSync(profilePath)) return;
  const singletonFiles = readdirSync(profilePath).filter((name) => name.startsWith('Singleton'));
  if (singletonFiles.length > 0) {
    throw new Error(
      `Browser Profile retained Chromium Singleton files after shutdown: ${singletonFiles.join(', ')}`,
    );
  }
}

async function main() {
  const base = serviceConfig(false);
  if (publishedTargets(base).includes(novncPort) || publishedTargets(base).includes(6080)) {
    throw new Error('Base Compose unexpectedly publishes a noVNC port');
  }

  const maintenance = serviceConfig(true);
  const securityOptions = maintenance.security_opt ?? [];
  if (!securityOptions.some((value) => String(value).includes('seccomp_profile.json'))) {
    throw new Error('Maintenance Compose must apply the vendored Playwright seccomp profile');
  }
  if ((maintenance.cap_add ?? []).some((value) => String(value).toUpperCase() === 'SYS_ADMIN')) {
    throw new Error('Maintenance Compose must not add SYS_ADMIN');
  }
  const novncMapping = publishedPort(maintenance, novncPort);
  if (!novncMapping) {
    throw new Error('Maintenance Compose overlay does not publish the configured noVNC port');
  }
  if (novncMapping.host_ip !== '127.0.0.1') {
    throw new Error(`Expected noVNC to bind 127.0.0.1 by default, got ${novncMapping.host_ip}`);
  }

  try {
    runDocker(composeArgs(false, 'up', '-d', '--no-build'));
    await waitForHealth();
    await assertHttpContract();
    let baseId = containerId(false);
    assertRuntimeIdentity(baseId);
    assertPersistence(baseId);
    assertBrowserMode(baseId, false);
    assertMaintenanceProcesses(baseId, false);

    runDocker(composeArgs(false, 'restart', 'gateway'));
    await waitForHealth();
    baseId = containerId(false);
    assertRuntimeIdentity(baseId);
    assertPersistence(baseId);
    assertBrowserMode(baseId, false);
    assertMaintenanceProcesses(baseId, false);
  } finally {
    down(false);
  }

  try {
    runDocker(composeArgs(true, 'up', '-d', '--no-build'));
    await waitForHealth();
    await waitForNovnc();
    await assertNovncRfbHandshake();
    const maintenanceId = containerId(true);
    assertRuntimeIdentity(maintenanceId);
    assertPersistence(maintenanceId);
    assertBrowserMode(maintenanceId, true);
    assertMaintenanceProcesses(maintenanceId, true);
  } finally {
    down(true);
  }
  assertProfileUnlocked(path.join(dataPath, 'e2e-browser-profile'));

  console.log('Docker smoke passed.');
}

try {
  await main();
} finally {
  rmSync(dataPath, { recursive: true, force: true });
}
