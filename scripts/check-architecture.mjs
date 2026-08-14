import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

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

const rules = [
  {
    dir: 'api',
    forbidden: (value) => value === 'playwright' || value.startsWith('playwright/'),
    message: 'api/ must not import Playwright directly',
  },
  {
    dir: 'context',
    forbidden: (value) =>
      value === 'playwright' ||
      value.startsWith('playwright/') ||
      /(?:^|\/)api(?:\/|$)/.test(value) ||
      /(?:^|\/)chatgpt(?:\/|$)/.test(value),
    message: 'context/ must stay pure and independent from api/chatgpt/playwright',
  },
  {
    dir: 'stream',
    forbidden: (value) => /chatgpt\/selectors/.test(value),
    message: 'stream/ must not import ChatGPT selectors',
  },
  {
    dir: 'persistence',
    forbidden: (value) => value === 'playwright' || value.startsWith('playwright/'),
    message: 'persistence/ must not import Playwright',
  },
  {
    dir: 'browser',
    forbidden: (value) => /(?:^|\/)(?:api|persistence|chatgpt)(?:\/|$)/.test(value),
    message: 'browser/ must stay independent from api/persistence/chatgpt',
  },
  {
    dir: 'chatgpt',
    forbidden: (value) =>
      /(?:^|\/)(?:api|persistence)(?:\/|$)/.test(value) ||
      /browser\/(?:browser-manager|page-pool)/.test(value),
    message: 'chatgpt/ must not depend on api/persistence or BrowserManager/PagePool implementations',
  },
];

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

  if (!relative.startsWith('src/persistence/')) {
    for (const imported of importsFrom(content)) {
      if (imported === 'node:sqlite') {
        errors.push(`${relative} imports node:sqlite; SQLite access belongs in src/persistence/`);
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
