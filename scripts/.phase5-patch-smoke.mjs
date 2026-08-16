import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('./docker-smoke.mjs', import.meta.url);
let source = readFileSync(path, 'utf8');

const startOld = `function cleanupDataPath() {
  const cleanup = spawnSync(
`;
const startNew = `function cleanupDataPath() {
  const owner = \`${'${process.getuid()}'}:${'${process.getgid()}'}\`;
  const cleanup = spawnSync(
`;
if (!source.includes(startOld)) throw new Error('cleanupDataPath start changed unexpectedly');
source = source.replace(startOld, startNew);

const commandOld = `      "find /cleanup -mindepth 1 -delete",
`;
const commandNew = `      \`find /cleanup -mindepth 1 -delete && chown ${'${owner}'} /cleanup\`,
`;
if (!source.includes(commandOld)) throw new Error('cleanup command changed unexpectedly');
source = source.replace(commandOld, commandNew);

writeFileSync(path, source);
