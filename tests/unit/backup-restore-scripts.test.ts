import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const temporaryRoots: string[] = [];

function makeTempRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cwg-backup-test-'));
  temporaryRoots.push(directory);
  return directory;
}

function runScript(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function writeFixture(dataDir: string): void {
  const files: Array<[string, Buffer | string]> = [
    ['gateway.db', Buffer.from('sqlite-fixture\u0000bytes')],
    ['files/blobs/sha256-a', Buffer.from([0, 1, 2, 3, 255])],
    ['generated/11111111-1111-4111-8111-111111111111.png', Buffer.from('png-fixture-bytes')],
    ['browser-profile/Default/Cookies', Buffer.from('encrypted-cookie-fixture')],
    ['browser-profile/Local State', '{"profile":"fixture"}\n'],
    ['temp/keep-boundary.txt', 'temporary-boundary-fixture\n'],
  ];

  for (const [path, content] of files) {
    const absolute = join(dataDir, path);
    mkdirSync(resolve(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content);
  }
}

function listFiles(directory: string): string[] {
  const result: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result.push(relative(directory, absolute));
    }
  };
  visit(directory);
  return result.sort();
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('cold backup and restore scripts', () => {
  it('round-trips the complete DATA_DIR byte boundary with a supported manifest', () => {
    const temporaryRoot = makeTempRoot();
    const dataDir = join(temporaryRoot, 'data');
    const backupDir = join(temporaryRoot, 'backup');
    const restoredDir = join(temporaryRoot, 'restored');
    mkdirSync(dataDir);
    writeFixture(dataDir);

    const sourceFiles = listFiles(dataDir);
    const backup = runScript('scripts/backup-data.mjs', [dataDir, backupDir, '--gateway-stopped']);
    expect(backup.status, backup.stderr).toBe(0);
    expect(backup.stdout).toContain('Cold backup created');

    const manifest = JSON.parse(readFileSync(join(backupDir, 'BACKUP_MANIFEST.json'), 'utf8')) as {
      schema?: unknown;
      cold_backup?: unknown;
      entries?: unknown;
    };
    expect(manifest).toMatchObject({ schema: 1, cold_backup: true });
    expect(manifest.entries).toEqual(
      expect.arrayContaining(['gateway.db', 'files', 'generated', 'browser-profile']),
    );
    expect(statSync(join(backupDir, 'BACKUP_MANIFEST.json')).mode & 0o777).toBe(0o600);

    const restore = runScript('scripts/restore-data.mjs', [
      backupDir,
      restoredDir,
      '--gateway-stopped',
    ]);
    expect(restore.status, restore.stderr).toBe(0);
    expect(restore.stdout).toContain('Cold backup restored');
    expect(listFiles(restoredDir)).toEqual(sourceFiles);

    for (const path of sourceFiles) {
      expect(readFileSync(join(restoredDir, path)), path).toEqual(
        readFileSync(join(dataDir, path)),
      );
    }
  });

  it('requires explicit stopped-Gateway acknowledgement and an empty restore target', () => {
    const temporaryRoot = makeTempRoot();
    const dataDir = join(temporaryRoot, 'data');
    const backupDir = join(temporaryRoot, 'backup');
    const restoredDir = join(temporaryRoot, 'restored');
    mkdirSync(dataDir);
    writeFixture(dataDir);

    const missingAcknowledgement = runScript('scripts/backup-data.mjs', [dataDir, backupDir]);
    expect(missingAcknowledgement.status).toBe(64);
    expect(missingAcknowledgement.stderr).toContain('--gateway-stopped');

    const backup = runScript('scripts/backup-data.mjs', [dataDir, backupDir, '--gateway-stopped']);
    expect(backup.status, backup.stderr).toBe(0);

    mkdirSync(restoredDir);
    writeFileSync(join(restoredDir, 'already-here'), 'do not overwrite');
    const restore = runScript('scripts/restore-data.mjs', [
      backupDir,
      restoredDir,
      '--gateway-stopped',
    ]);
    expect(restore.status).toBe(64);
    expect(restore.stderr).toContain('must be empty');
    expect(readFileSync(join(restoredDir, 'already-here'), 'utf8')).toBe('do not overwrite');
  });
});
