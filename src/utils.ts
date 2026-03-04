import * as fs from 'node:fs';
import { promisify } from 'node:util';

import { ZonedDateTime, LocalDateTime } from '@js-joda/core';

import type { Attribute } from '@orangebeard-io/javascript-client/dist/client/models/Attribute';
import type { OrangebeardParameters } from '@orangebeard-io/javascript-client/dist/client/models/OrangebeardParameters';
import type { StartTestRun } from '@orangebeard-io/javascript-client/dist/client/models/StartTestRun';
import autoConfig from '@orangebeard-io/javascript-client/dist/client/util/autoConfig';

const stat = promisify(fs.stat);
const access = promisify(fs.access);

async function fileExists(filepath: string): Promise<boolean> {
  try {
    await access(filepath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(filepath: string, interval = 500, timeout = 10000): Promise<void> {
  const start = Date.now();

  while (true) {
    const now = Date.now();
    if (now - start > timeout) {
      throw new Error(`Timeout: ${filepath} did not become available within ${timeout}ms`);
    }

    if (await fileExists(filepath)) {
      const initialStat = await stat(filepath);
      await new Promise((resolve) => setTimeout(resolve, interval));
      const finalStat = await stat(filepath);

      if (initialStat.mtimeMs === finalStat.mtimeMs && initialStat.size === finalStat.size) {
        return;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export async function getBytes(filePath: string): Promise<Buffer> {
  await waitForFile(filePath, 100, 5000);
  return fs.readFileSync(filePath);
}

export function getTime(): string {
  return ZonedDateTime.now().withFixedOffsetZone().toString();
}

export function getTimeFromMs(ms: number): string {
  const offset = ZonedDateTime.now().offset();
  const d = new Date(ms);

  const ldt = LocalDateTime.of(
    d.getFullYear(),
    d.getMonth() + 1,
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds() * 1_000_000,
  );

  return ZonedDateTime.of(ldt, offset).toString();
}

export function getOrangebeardConfig(configuration: any = {}): OrangebeardParameters {
  const options = configuration.reporterOptions ?? {};

  const base: OrangebeardParameters = { ...(autoConfig as any) };

  const merged: OrangebeardParameters = {
    ...base,
    token: options.token ?? base.token,
    endpoint: options.endpoint ?? base.endpoint,
    project: options.project ?? base.project,
    testset: options.testset ?? base.testset,
    description: options.description ?? base.description,
    referenceUrl: options.referenceUrl ?? base.referenceUrl,
  };

  const baseAttrs = (base.attributes ?? []) as Attribute[];
  const optAttrs = (options.attributes ?? []) as Attribute[];
  merged.attributes = baseAttrs.concat(optAttrs);

  if (merged.referenceUrl !== undefined) {
    const already = (merged.attributes ?? []).some(
      (a: Attribute) => a?.key === 'reference_url' && a?.value === merged.referenceUrl,
    );
    if (!already) {
      merged.attributes = (merged.attributes ?? []).concat({
        key: 'reference_url',
        value: merged.referenceUrl,
      });
    }
  }

  return merged;
}

export function getStartTestRun(params: {
  testset: string;
  description?: string;
  attributes?: any;
}): StartTestRun {
  return {
    testSetName: params.testset,
    description: params.description,
    attributes: params.attributes,
    startTime: getTime(),
  };
}
