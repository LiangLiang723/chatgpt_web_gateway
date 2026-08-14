import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const ignoredDirs = new Set(['node_modules', '.git', 'data', '.worktrees', 'worktrees']);
const markdownFiles = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith('.md')) markdownFiles.push(full);
  }
}
walk(root);

const errors = [];
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
for (const file of markdownFiles) {
  const content = fs.readFileSync(file, 'utf8');
  for (const match of content.matchAll(linkPattern)) {
    let target = match[1].trim();
    if (!target || target.startsWith('#')) continue;
    if (/^[a-z]+:/i.test(target)) continue;
    target = target.split('#')[0].split('?')[0];
    if (!target) continue;
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
    if (!fs.existsSync(resolved)) {
      errors.push(`${path.relative(root, file)} -> missing ${target}`);
    }
  }
}

if (errors.length) {
  console.error('Documentation link check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Documentation link check passed (${markdownFiles.length} markdown files).`);
