import { Ajv } from 'ajv';

import { AppConfigSchema } from './schema.js';
import type { AppConfig } from './schema.js';

const ajv = new Ajv({ allErrors: true });
const validateConfig = ajv.compile(AppConfigSchema);

function requireNonEmpty(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required and must be non-empty`);
  }
  return normalized;
}

function optionalNonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const uiMode = env.UI_MODE ?? 'headless';
  if (uiMode !== 'headless' && uiMode !== 'novnc') {
    throw new Error('UI_MODE must be either headless or novnc');
  }

  const candidate: AppConfig = {
    host: requireNonEmpty('HOST', env.HOST ?? '0.0.0.0'),
    port: parseInteger('PORT', env.PORT, 3000, 1, 65535),
    gatewayApiKey: requireNonEmpty('GATEWAY_API_KEY', env.GATEWAY_API_KEY),
    uiMode,
    puid: parseInteger('PUID', env.PUID, 1000, 1),
    pgid: parseInteger('PGID', env.PGID, 1000, 1),
    dataDir: requireNonEmpty('DATA_DIR', env.DATA_DIR ?? '/data'),
    maxActivePages: parseInteger('MAX_ACTIVE_PAGES', env.MAX_ACTIVE_PAGES, 4, 1, 32),
    novncPort: parseInteger('NOVNC_PORT', env.NOVNC_PORT, 6080, 1, 65535),
    novncPassword: optionalNonEmpty(env.NOVNC_PASSWORD),
  };

  if (!validateConfig(candidate)) {
    throw new Error(`Invalid Gateway configuration: ${ajv.errorsText(validateConfig.errors)}`);
  }

  return candidate;
}

export type { AppConfig } from './schema.js';
