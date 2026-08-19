import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { architectureImportRules as rules } from './architecture-rules.mjs';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'src');
const errors = [];

function sourceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(full));
    else if (/\.(?:[cm]?[jt]s|tsx)$/.test(entry.name)) result.push(full);
  }
  return result;
}

function importsFrom(content) {
  const results = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) results.push(match[1]);
  }
  return results;
}

for (const rule of rules) {
  for (const file of sourceFiles(path.join(src, rule.dir))) {
    const content = fs.readFileSync(file, 'utf8');
    for (const imported of importsFrom(content)) {
      if (rule.forbidden(imported)) {
        errors.push(`${path.relative(root, file)} imports ${imported}: ${rule.message}`);
      }
    }
  }
}

for (const file of sourceFiles(src)) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const content = fs.readFileSync(file, 'utf8');

  if (relative !== 'src/chatgpt/selectors.ts' && /data-testid|#prompt-textarea|data-message-author-role/.test(content)) {
    errors.push(`${relative} contains ChatGPT selector-like literals; keep selectors in src/chatgpt/selectors.ts`);
  }

  if (!relative.startsWith('src/config/') && /\bprocess\.env\b/.test(content)) {
    errors.push(`${relative} reads process.env directly; runtime configuration belongs in src/config/`);
  }

  const imports = importsFrom(content);
  if (!relative.startsWith('src/persistence/')) {
    for (const imported of imports) {
      if (imported === 'node:sqlite') {
        errors.push(`${relative} imports node:sqlite; SQLite access belongs in src/persistence/`);
      }
    }
  }

  if (
    relative === 'src/api/routes/files.ts' ||
    relative === 'src/chatgpt/driver.ts'
  ) {
    for (const imported of imports) {
      if (imported === 'node:fs' || imported === 'node:fs/promises') {
        errors.push(
          `${relative} imports ${imported}; File/Blob filesystem logic belongs in src/attachments/`,
        );
      }
    }
  }
}

if (errors.length) {
  console.error('Architecture check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Architecture check passed.');
