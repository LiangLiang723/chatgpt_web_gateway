import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    'Usage: node scripts/backup-data.mjs <data-dir> <backup-dir> --gateway-stopped\n',
  );
  process.exit(64);
}

const [sourceArg, destinationArg, confirmation, ...extra] = process.argv.slice(2);
if (!sourceArg || !destinationArg || confirmation !== '--gateway-stopped' || extra.length > 0)
  usage();

const source = resolve(sourceArg);
const destination = resolve(destinationArg);
if (source === destination || destination.startsWith(`${source}/`)) {
  usage('Backup destination must be outside DATA_DIR');
}

const sourceStat = await stat(source).catch(() => undefined);
if (!sourceStat?.isDirectory()) usage('DATA_DIR does not exist or is not a directory');
const sourceEntries = await readdir(source);
if (!sourceEntries.includes('gateway.db')) usage('DATA_DIR is missing gateway.db');

const destinationStat = await stat(destination).catch(() => undefined);
if (destinationStat) usage('Backup destination already exists');

await mkdir(destination, { recursive: false });
for (const entry of sourceEntries) {
  await cp(resolve(source, entry), resolve(destination, entry), {
    recursive: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
  });
}

const manifest = {
  schema: 1,
  created_at: new Date().toISOString(),
  source_basename: basename(source),
  cold_backup: true,
  entries: sourceEntries.sort(),
};
await writeFile(
  resolve(destination, 'BACKUP_MANIFEST.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { flag: 'wx', mode: 0o600 },
);
process.stdout.write(`Cold backup created at ${destination}\n`);
