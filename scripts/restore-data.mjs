import { cp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    'Usage: node scripts/restore-data.mjs <backup-dir> <data-dir> --gateway-stopped\n',
  );
  process.exit(64);
}

const [backupArg, destinationArg, confirmation, ...extra] = process.argv.slice(2);
if (!backupArg || !destinationArg || confirmation !== '--gateway-stopped' || extra.length > 0)
  usage();

const backup = resolve(backupArg);
const destination = resolve(destinationArg);
if (backup === destination || backup.startsWith(`${destination}/`)) {
  usage('Backup directory must be separate from DATA_DIR');
}

const backupStat = await stat(backup).catch(() => undefined);
if (!backupStat?.isDirectory()) usage('Backup directory does not exist');

let manifest;
try {
  manifest = JSON.parse(await readFile(resolve(backup, 'BACKUP_MANIFEST.json'), 'utf8'));
} catch {
  usage('Backup manifest is missing or invalid');
}
if (manifest?.schema !== 1 || manifest?.cold_backup !== true || !Array.isArray(manifest?.entries)) {
  usage('Backup manifest is not a supported cold backup');
}
if (!manifest.entries.includes('gateway.db')) usage('Backup manifest does not contain gateway.db');

const destinationStat = await stat(destination).catch(() => undefined);
if (destinationStat) {
  if (!destinationStat.isDirectory()) usage('DATA_DIR destination is not a directory');
  if ((await readdir(destination)).length > 0) usage('DATA_DIR destination must be empty');
} else {
  await mkdir(destination, { recursive: true });
}

for (const entry of manifest.entries) {
  if (
    typeof entry !== 'string' ||
    entry.length === 0 ||
    entry === '.' ||
    entry === '..' ||
    entry.includes('/')
  ) {
    usage('Backup manifest contains an unsafe entry');
  }
  await cp(resolve(backup, entry), resolve(destination, entry), {
    recursive: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
  });
}
process.stdout.write(`Cold backup restored into ${destination}\n`);
