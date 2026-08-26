import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('project status script', () => {
  it('summarizes Git and Project Memory as machine-readable JSON', () => {
    const result = spawnSync(process.execPath, ['scripts/project-status.mjs', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout) as {
      branch?: unknown;
      head?: unknown;
      dirtyCount?: unknown;
      phase?: unknown;
      status?: unknown;
      activePlan?: unknown;
      nextTask?: unknown;
      planStep?: { status?: unknown; text?: unknown } | null;
    };

    expect(body.branch).toEqual(expect.any(String));
    expect(body.head).toMatch(/^[0-9a-f]{7,40}$/);
    expect(body.dirtyCount).toEqual(expect.any(Number));
    expect(body.phase).toEqual(expect.any(String));
    expect(body.status).toEqual(expect.any(String));
    expect(body.activePlan).toMatch(/^(?:none|docs\/superpowers\/plans\/)/);
    expect(body.nextTask).toMatch(/\S/);
    if (body.activePlan === 'none') {
      expect(body.planStep).toBeNull();
    } else if (body.planStep !== null) {
      expect(body.planStep).toMatchObject({
        status: expect.stringMatching(/^(pending|blocked)$/),
        text: expect.stringMatching(/\S/),
      });
    }
  });
});
