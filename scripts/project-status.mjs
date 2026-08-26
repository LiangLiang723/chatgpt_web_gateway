import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');

function git(...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function parseMachineState(markdown) {
  const match = markdown.match(/```text\n([\s\S]*?)\n```/);
  if (!match) throw new Error('PROJECT_STATE Machine State text block is missing');
  const values = new Map();
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

function firstUnresolvedPlanStep(activePlan) {
  if (!activePlan || activePlan === 'none') return null;
  const plan = readFileSync(path.join(root, activePlan), 'utf8');
  const match = plan.match(/^- \[([ !])\] \*\*(.+?)\*\*/m);
  if (!match) return null;
  return {
    status: match[1] === '!' ? 'blocked' : 'pending',
    text: match[2],
  };
}

function statusSummary() {
  const state = parseMachineState(
    readFileSync(path.join(root, 'docs', 'PROJECT_STATE.md'), 'utf8'),
  );
  const dirtyLines = git('status', '--porcelain');
  const activePlan = state.get('ACTIVE_PLAN') ?? 'none';
  return {
    branch: git('branch', '--show-current'),
    head: git('rev-parse', '--short=12', 'HEAD'),
    dirtyCount: dirtyLines ? dirtyLines.split('\n').length : 0,
    phase: state.get('PHASE') ?? '',
    status: state.get('STATUS') ?? '',
    activePlan,
    nextTask: state.get('NEXT_TASK') ?? '',
    planStep: firstUnresolvedPlanStep(activePlan),
  };
}

const summary = statusSummary();
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} else {
  process.stdout.write(
    [
      `Branch: ${summary.branch}`,
      `HEAD: ${summary.head}`,
      `Dirty: ${summary.dirtyCount} file${summary.dirtyCount === 1 ? '' : 's'}`,
      '',
      `Phase: ${summary.phase}`,
      `Status: ${summary.status}`,
      `Active plan: ${summary.activePlan}`,
      `Next task: ${summary.nextTask}`,
      summary.planStep
        ? `First unresolved plan step: [${summary.planStep.status}] ${summary.planStep.text}`
        : 'First unresolved plan step: none',
      '',
    ].join('\n'),
  );
}
