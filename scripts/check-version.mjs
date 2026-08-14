import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const errors = [];

const packagePath = path.join(root, 'package.json');
const versionPath = path.join(root, 'VERSION');
const changelogPath = path.join(root, 'CHANGELOG.md');
const statePath = path.join(root, 'docs', 'PROJECT_STATE.md');

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const packageVersion = pkg.version;
const displayVersion = fs.readFileSync(versionPath, 'utf8').trim();
const expectedDisplayVersion = `V${packageVersion}`;

if (!/^\d+\.\d+\.\d+$/.test(packageVersion)) {
  errors.push(`package.json version must be x.y.z without V: ${packageVersion}`);
}

if (!/^V\d+\.\d+\.\d+$/.test(displayVersion)) {
  errors.push(`VERSION must use Vx.y.z: ${displayVersion}`);
}

if (displayVersion !== expectedDisplayVersion) {
  errors.push(`VERSION (${displayVersion}) does not match package.json (${packageVersion})`);
}

const changelog = fs.readFileSync(changelogPath, 'utf8');
if (!changelog.includes(`## ${displayVersion}`)) {
  errors.push(`CHANGELOG.md has no section for ${displayVersion}`);
}

const state = fs.readFileSync(statePath, 'utf8');
if (!state.includes(`RELEASE_VERSION=${displayVersion}`)) {
  errors.push(`PROJECT_STATE RELEASE_VERSION does not match ${displayVersion}`);
}

if (errors.length) {
  console.error('Version check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Version check passed (${displayVersion}).`);
