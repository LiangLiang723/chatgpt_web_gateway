import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const compose = readFileSync(resolve('compose.yaml'), 'utf8');
const envExample = readFileSync(resolve('.env.example'), 'utf8');

describe('Docker Compose proxy boundary', () => {
  it('provides the Docker-host gateway alias for container-safe host proxies', () => {
    expect(compose).toContain('host.docker.internal:host-gateway');
  });

  it.each(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'])(
    'passes optional %s through to the Gateway container',
    (name) => {
      expect(compose).toContain(`${name}: \${${name}:-}`);
    },
  );

  it('documents host.docker.internal instead of container loopback for a host proxy', () => {
    expect(envExample).toContain('http://host.docker.internal:7890');
    expect(envExample).not.toContain('HTTP_PROXY=http://127.0.0.1:7890');
    expect(envExample).not.toContain('HTTPS_PROXY=http://127.0.0.1:7890');
    expect(envExample).not.toContain('ALL_PROXY=http://127.0.0.1:7890');
  });
});
