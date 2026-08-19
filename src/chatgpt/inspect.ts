import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { Page } from 'playwright';

import { parseChatGptProxyServer } from '../config/proxy.js';
import { probeAuth } from './auth.js';
import { asChatGptDriverError } from './errors.js';
import { inspectCollection, inspectUnique, resolveCollection } from './selector-registry.js';
import { chatGptSelectors } from './selectors.js';

export interface InspectEnvironment {
  DATA_DIR?: string;
  CHATGPT_PROFILE_DIR?: string;
  CHATGPT_DIAGNOSTICS_DIR?: string;
  CHATGPT_ATTACHMENT_PROBE_PATH?: string;
  CHATGPT_PROXY_SERVER?: string;
}

export interface ParsedInspectEnvironment {
  profileDir: string;
  diagnosticsDir?: string;
  attachmentProbePath?: string;
  proxyServer?: string;
}

export interface InspectChatGptPageOptions {
  diagnosticsDir?: string;
  attachmentProbePath?: string;
  mkdir?: typeof mkdirSync;
  writeFile?: typeof writeFileSync;
}

export interface AttachmentFileInputDiagnostic {
  tag: string;
  testId?: string;
  name?: string;
  accept?: string;
  className?: string;
  multiple: boolean;
  disabled: boolean;
}

export interface AttachmentDomDiagnostic {
  tag: string;
  className?: string;
  testId?: string;
  ariaLabel?: string;
  role?: string;
  dataState?: string;
  dataStatus?: string;
  ariaBusy?: string;
  ariaInvalid?: string;
  title?: string;
  disabled?: boolean;
}

export interface AttachmentProbeSnapshot {
  elapsedMs: number;
  tileCount: number;
  alertCount: number;
  ownedPendingCount?: number;
  ownedLabel?: string;
}

export type AttachmentProbeDiagnostic =
  | { status: 'not_run'; reason: 'generic_file_input_not_unique' }
  | {
      status: 'observed';
      filename: string;
      inputIndex: number;
      baselineTiles: number;
      baselineAlerts: number;
      outcome: 'ready' | 'error' | 'timeout';
      snapshots: AttachmentProbeSnapshot[];
    }
  | {
      status: 'failed';
      filename: string;
      inputIndex: number;
      error: 'set_input_files_failed';
    };

export interface InspectChatGptResult {
  url: string;
  auth: 'authenticated' | 'auth_required' | 'unknown';
  selectors: {
    composer: 'unique' | 'missing' | 'ambiguous';
    sendButton: 'unique' | 'missing' | 'ambiguous';
    assistantTurns: { status: 'collection'; count: number };
    stopControl: 'unique' | 'missing' | 'ambiguous';
  };
  attachments: {
    fileInputs: {
      status: 'missing' | 'unique' | 'collection';
      count: number;
      items: AttachmentFileInputDiagnostic[];
    };
    candidateControls: AttachmentDomDiagnostic[];
    candidateStates: AttachmentDomDiagnostic[];
    probe?: AttachmentProbeDiagnostic;
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseInspectEnvironment(env: InspectEnvironment): ParsedInspectEnvironment {
  const profile = nonEmpty(env.CHATGPT_PROFILE_DIR);
  if (!profile) throw new Error('e2e_profile_required');

  const profileDir = resolve(profile);
  const dataDir = resolve(nonEmpty(env.DATA_DIR) ?? '/data');
  const productionProfile = resolve(dataDir, 'browser-profile');
  if (profileDir === productionProfile) throw new Error('e2e_profile_must_be_isolated');

  const diagnostics = nonEmpty(env.CHATGPT_DIAGNOSTICS_DIR);
  const attachmentProbePath = nonEmpty(env.CHATGPT_ATTACHMENT_PROBE_PATH);
  const proxyServer = parseChatGptProxyServer(env.CHATGPT_PROXY_SERVER);
  return {
    profileDir,
    ...(diagnostics ? { diagnosticsDir: resolve(diagnostics) } : {}),
    ...(attachmentProbePath ? { attachmentProbePath: resolve(attachmentProbePath) } : {}),
    ...(proxyServer ? { proxyServer } : {}),
  };
}

function uniqueStatus(
  value: Awaited<ReturnType<typeof inspectUnique>>,
): 'unique' | 'missing' | 'ambiguous' {
  return value.status;
}

function optionalAttribute(value: string | null): string | undefined {
  return value === null || value === '' ? undefined : value;
}

async function inspectAttachmentInputs(page: Page): Promise<{
  status: 'missing' | 'unique' | 'collection';
  count: number;
  items: AttachmentFileInputDiagnostic[];
}> {
  const locator = resolveCollection(page, chatGptSelectors.attachmentFileInputs);
  const count = await locator.count();
  const items = await locator.evaluateAll((elements) =>
    elements.map((element) => {
      const input = element as HTMLInputElement;
      return {
        tag: input.tagName,
        testId: input.dataset.testid ?? null,
        name: input.getAttribute('name'),
        accept: input.getAttribute('accept'),
        className: input.getAttribute('class'),
        multiple: input.multiple,
        disabled: input.disabled,
      };
    }),
  );
  return {
    status: count === 0 ? 'missing' : count === 1 ? 'unique' : 'collection',
    count,
    items: items.map((item) => ({
      tag: item.tag,
      ...(optionalAttribute(item.testId) === undefined
        ? {}
        : { testId: optionalAttribute(item.testId) }),
      ...(optionalAttribute(item.name) === undefined ? {} : { name: optionalAttribute(item.name) }),
      ...(optionalAttribute(item.accept) === undefined
        ? {}
        : { accept: optionalAttribute(item.accept) }),
      ...(optionalAttribute(item.className) === undefined
        ? {}
        : { className: optionalAttribute(item.className) }),
      multiple: item.multiple,
      disabled: item.disabled,
    })),
  };
}

async function inspectAttachmentCandidates(
  locator: ReturnType<typeof resolveCollection>,
): Promise<AttachmentDomDiagnostic[]> {
  const rows = await locator.evaluateAll((elements) =>
    elements
      .map((element) => ({
        tag: element.tagName,
        className: element.getAttribute('class'),
        testId: (element as HTMLElement).dataset.testid ?? null,
        ariaLabel: element.getAttribute('aria-label'),
        role: element.getAttribute('role'),
        dataState: element.getAttribute('data-state'),
        dataStatus: element.getAttribute('data-status'),
        ariaBusy: element.getAttribute('aria-busy'),
        ariaInvalid: element.getAttribute('aria-invalid'),
        title: element.getAttribute('title'),
        disabled:
          element instanceof HTMLButtonElement || element instanceof HTMLInputElement
            ? element.disabled
            : undefined,
      }))
      .filter((row) =>
        [
          row.testId,
          row.ariaLabel,
          row.dataState,
          row.dataStatus,
          row.ariaBusy,
          row.ariaInvalid,
          row.title,
        ].some(
          (value) =>
            typeof value === 'string' &&
            /(^|[^a-z])(attach(?:ment)?|upload|files?|preview|pending|ready|error)([^a-z]|$)/i.test(
              value,
            ),
        ),
      )
      .slice(0, 50),
  );
  return rows.map((row) => ({
    tag: row.tag,
    ...(optionalAttribute(row.className) === undefined
      ? {}
      : { className: optionalAttribute(row.className) }),
    ...(optionalAttribute(row.testId) === undefined
      ? {}
      : { testId: optionalAttribute(row.testId) }),
    ...(optionalAttribute(row.ariaLabel) === undefined
      ? {}
      : { ariaLabel: optionalAttribute(row.ariaLabel) }),
    ...(optionalAttribute(row.role) === undefined ? {} : { role: optionalAttribute(row.role) }),
    ...(optionalAttribute(row.dataState) === undefined
      ? {}
      : { dataState: optionalAttribute(row.dataState) }),
    ...(optionalAttribute(row.dataStatus) === undefined
      ? {}
      : { dataStatus: optionalAttribute(row.dataStatus) }),
    ...(optionalAttribute(row.ariaBusy) === undefined
      ? {}
      : { ariaBusy: optionalAttribute(row.ariaBusy) }),
    ...(optionalAttribute(row.ariaInvalid) === undefined
      ? {}
      : { ariaInvalid: optionalAttribute(row.ariaInvalid) }),
    ...(optionalAttribute(row.title) === undefined ? {} : { title: optionalAttribute(row.title) }),
    ...(row.disabled === undefined ? {} : { disabled: row.disabled }),
  }));
}

async function inspectAttachmentProbe(
  page: Page,
  fileInputs: Awaited<ReturnType<typeof inspectAttachmentInputs>>,
  probePath: string,
): Promise<AttachmentProbeDiagnostic> {
  const genericInputIndexes = fileInputs.items.flatMap((item, index) =>
    item.accept === undefined ? [index] : [],
  );
  if (genericInputIndexes.length !== 1) {
    return { status: 'not_run', reason: 'generic_file_input_not_unique' };
  }

  const inputIndex = genericInputIndexes[0] as number;
  const filename = basename(probePath);
  const tiles = await inspectCollection(page, chatGptSelectors.attachmentTiles);
  const alerts = await inspectCollection(page, chatGptSelectors.attachmentUploadAlerts);
  const baselineTiles = tiles.count;
  const baselineAlerts = alerts.count;

  try {
    await resolveCollection(page, chatGptSelectors.attachmentFileInputs)
      .nth(inputIndex)
      .setInputFiles(probePath);
  } catch {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
    return { status: 'failed', filename, inputIndex, error: 'set_input_files_failed' };
  }

  const snapshots: AttachmentProbeSnapshot[] = [];
  let previous = '';
  let outcome: 'ready' | 'error' | 'timeout' = 'timeout';

  try {
    for (let sample = 0; sample <= 240; sample += 1) {
      if (sample > 0) await page.waitForTimeout(250);
      const elapsedMs = sample * 250;
      const alertCount = await alerts.locator.count();
      const tileCount = await tiles.locator.count();
      const snapshot: AttachmentProbeSnapshot = { elapsedMs, tileCount, alertCount };

      if (alertCount > baselineAlerts) {
        outcome = 'error';
      } else if (tileCount < baselineTiles || tileCount > baselineTiles + 1) {
        outcome = 'error';
      } else if (tileCount === baselineTiles + 1) {
        const ownedTile = tiles.locator.nth(baselineTiles);
        const pending = chatGptSelectors.attachmentTilePending.locate(ownedTile);
        snapshot.ownedPendingCount = await pending.count();
        const ownedLabel = await ownedTile.getAttribute('aria-label');
        if (ownedLabel) snapshot.ownedLabel = ownedLabel;
        if (snapshot.ownedPendingCount === 0) outcome = 'ready';
      }

      const serialized = JSON.stringify(snapshot);
      if (serialized !== previous) {
        snapshots.push(snapshot);
        previous = serialized;
      }
      if (outcome !== 'timeout') break;
    }
  } finally {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
  }

  return {
    status: 'observed',
    filename,
    inputIndex,
    baselineTiles,
    baselineAlerts,
    outcome,
    snapshots,
  };
}

export async function inspectChatGptPage(
  page: Page,
  options: InspectChatGptPageOptions = {},
): Promise<InspectChatGptResult> {
  try {
    await page.goto('https://chatgpt.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    const auth = await probeAuth(page);
    const composer = await inspectUnique(page, chatGptSelectors.composer);
    const sendButton = await inspectUnique(page, chatGptSelectors.sendButton);
    const assistantTurns = await inspectCollection(page, chatGptSelectors.assistantTurns);
    const stopControl = await inspectUnique(page, chatGptSelectors.stopControl);
    const fileInputs = await inspectAttachmentInputs(page);
    const candidateControls = await inspectAttachmentCandidates(
      resolveCollection(page, chatGptSelectors.attachmentDiagnosticControls),
    );
    const candidateStates = await inspectAttachmentCandidates(
      resolveCollection(page, chatGptSelectors.attachmentDiagnosticStates),
    );
    const attachmentProbe = options.attachmentProbePath
      ? await inspectAttachmentProbe(page, fileInputs, options.attachmentProbePath)
      : undefined;

    if (options.diagnosticsDir) {
      const mkdir = options.mkdir ?? mkdirSync;
      const writeFile = options.writeFile ?? writeFileSync;
      mkdir(options.diagnosticsDir, { recursive: true });
      await page.screenshot({
        path: join(options.diagnosticsDir, 'chatgpt.png'),
        fullPage: true,
      });
      writeFile(join(options.diagnosticsDir, 'chatgpt.html'), await page.content(), 'utf8');
    }

    return {
      url: page.url(),
      auth: auth.state,
      selectors: {
        composer: uniqueStatus(composer),
        sendButton: uniqueStatus(sendButton),
        assistantTurns: { status: 'collection', count: assistantTurns.count },
        stopControl: uniqueStatus(stopControl),
      },
      attachments: {
        fileInputs,
        candidateControls,
        candidateStates,
        ...(attachmentProbe === undefined ? {} : { probe: attachmentProbe }),
      },
    };
  } catch (error) {
    throw asChatGptDriverError(error, 'ChatGPT inspection page operation failed');
  }
}
