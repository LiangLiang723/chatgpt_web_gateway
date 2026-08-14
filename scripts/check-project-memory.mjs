import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const statePath = path.join(root, 'docs', 'PROJECT_STATE.md');
const requiredFiles = [
  'AGENTS.md',
  'README.md',
  'SECURITY.md',
  'docs/PROJECT_STATE.md',
  'docs/project-memory-protocol.md',
  'docs/development-workflow.md',
  'docs/architecture.md',
  'docs/api-compatibility.md',
  'docs/testing.md',
  'docs/git-commit-convention.md',
  'docs/roadmap.md',
  'docs/superpowers/README.md',
];

const errors = [];
for (const relative of requiredFiles) {
  if (!fs.existsSync(path.join(root, relative))) {
    errors.push(`missing required file: ${relative}`);
  }
}

if (!fs.existsSync(statePath)) {
  errors.push('docs/PROJECT_STATE.md is missing');
} else {
  const state = fs.readFileSync(statePath, 'utf8');
  const match = state.match(/```text\n([\s\S]*?)\n```/);
  if (!match) {
    errors.push('PROJECT_STATE Machine State text block is missing');
  } else {
    const values = new Map();
    for (const line of match[1].split('\n')) {
      const separator = line.indexOf('=');
      if (separator === -1) continue;
      values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }

    const requiredKeys = [
      'PROJECT_STATE_SCHEMA',
      'PHASE',
      'STATUS',
      'GOVERNING_SPEC',
      'ACTIVE_PLAN',
      'NEXT_TASK',
      'UPDATED_AT',
    ];
    for (const key of requiredKeys) {
      if (!values.get(key)) errors.push(`PROJECT_STATE missing ${key}`);
    }

    if (values.get('PROJECT_STATE_SCHEMA') !== '1') {
      errors.push('unsupported PROJECT_STATE_SCHEMA; expected 1');
    }

    const spec = values.get('GOVERNING_SPEC');
    if (spec && !fs.existsSync(path.join(root, spec))) {
      errors.push(`GOVERNING_SPEC does not exist: ${spec}`);
    }

    const plan = values.get('ACTIVE_PLAN');
    if (plan && plan !== 'none' && !fs.existsSync(path.join(root, plan))) {
      errors.push(`ACTIVE_PLAN does not exist: ${plan}`);
    }

    const nextTask = values.get('NEXT_TASK');
    if (nextTask && /^(continue|next|later|unknown|none)$/i.test(nextTask)) {
      errors.push(`NEXT_TASK is not actionable: ${nextTask}`);
    }

    const updatedAt = values.get('UPDATED_AT');
    if (updatedAt && !/^\d{4}-\d{2}-\d{2}$/.test(updatedAt)) {
      errors.push(`UPDATED_AT must be YYYY-MM-DD: ${updatedAt}`);
    }
  }
}

const docsToScan = [
  'AGENTS.md',
  'README.md',
  'docs/PROJECT_STATE.md',
  'docs/project-memory-protocol.md',
  'docs/architecture.md',
  'docs/api-compatibility.md',
  'docs/testing.md',
  'docs/roadmap.md',
];
for (const relative of docsToScan) {
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) continue;
  const content = fs.readFileSync(full, 'utf8');
  const placeholder = content.match(/\b(TBD|TODO)\b|待定|稍后补充/i);
  if (placeholder) errors.push(`${relative} contains placeholder text: ${placeholder[0]}`);
}

if (errors.length) {
  console.error('Project memory check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Project memory check passed.');
