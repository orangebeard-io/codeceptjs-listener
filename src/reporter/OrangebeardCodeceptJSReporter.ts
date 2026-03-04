import { UUID } from 'crypto';
import * as path from 'node:path';
import { createRequire } from 'node:module';

import Mocha from 'mocha';
import OrangebeardAsyncV3Client from '@orangebeard-io/javascript-client/dist/client/OrangebeardAsyncV3Client';
import type { Attachment } from '@orangebeard-io/javascript-client/dist/client/models/Attachment';

import { level, status, testEntity } from '../constants';
import { getBytes, getOrangebeardConfig, getStartTestRun, getTime, getTimeFromMs } from '../utils';
import { buildErrorLogs, formatAsMarkdownJson } from './logging';
import { getTestAttributes, mergeAttributesFromEntityAndTitle, mergeSuiteAttributesFromTitle } from './tags';

// Resolve CodeceptJS modules relative to the consuming project (cwd), so it works when this
// package is linked/installed locally.
const requireFromCwd = createRequire(process.cwd() + '/');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const codeceptEvent = requireFromCwd('codeceptjs/lib/event');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { screenshotOutputFolder } = requireFromCwd('codeceptjs/lib/utils');

type ReporterConfiguration = {
  reporterOptions?: Record<string, any>;
};

type ActiveItem = {
  tempId: UUID;
  name: string;
  attributes?: any[];
};

/**
 * Mocha reporter that sends CodeceptJS test results to Orangebeard.
 *
 * CodeceptJS uses Mocha as its test runner.  Configure this reporter in
 * `codecept.conf.js` via the `mocha.reporter` option.
 *
 * Features → Suites, Scenarios → Tests, I.* steps → Steps, screenshots → Attachments.
 */
export default class OrangebeardCodeceptJSReporter extends Mocha.reporters.Base {
  private readonly options: Record<string, any>;

  private client: OrangebeardAsyncV3Client;
  private testRun: UUID | null = null;
  private disabled = false;

  private activeSuites: ActiveItem[] = [];
  private activeTests: ActiveItem[] = [];
  private inflight: Set<Promise<unknown>> = new Set();
  private testIdMap: Map<string, UUID> = new Map();
  private uploadedAttachments: Set<string> = new Set();
  private finishedTests: Set<UUID> = new Set();
  private stepsReported: Set<UUID> = new Set();
  private stepMap: Map<any, UUID> = new Map();
  private readonly realtimeSteps = true;
  private readonly logDataAsMarkdown = true;
  private iterationCounter: Map<string, number> = new Map();

  constructor(runner: Mocha.Runner, configuration: ReporterConfiguration) {
    super(runner, configuration as any);

    this.options = configuration?.reporterOptions ?? {};

    // ── Client initialisation ─────────────────────────────────────────
    this.client = !Object.keys(this.options).length
      ? new OrangebeardAsyncV3Client()
      : new OrangebeardAsyncV3Client(getOrangebeardConfig(configuration));

    // ── Validate critical configuration ───────────────────────────────
    const testset = this.resolveTestset();
    if (!testset) {
      // eslint-disable-next-line no-console
      console.error(
        '[Orangebeard] Missing required configuration: testset. ' +
          'Set it via orangebeard.json, reporterOptions.testset, or ORANGEBEARD_TESTSET.',
      );
      this.disabled = true;
    }

    if (this.disabled) return;

    // ── CodeceptJS event hooks (outside Mocha lifecycle) ──────────────
    codeceptEvent.dispatcher.on(codeceptEvent.step.finished, (step: any) => {
      if (step?.name === 'saveScreenshot') {
        const fileName = step?.args?.[0];
        if (typeof fileName === 'string' && fileName.trim()) {
          const filePath = screenshotOutputFolder(fileName);
          this.track(
            this.attachFileToTest(
              step?.test ?? step?.context?.test,
              filePath,
              `Screenshot: ${path.basename(filePath)}`,
            ),
          );
        }
      }
    });
    // Real-time step reporting
    codeceptEvent.dispatcher.on(codeceptEvent.step.started, (step: any) => {
      if (!this.realtimeSteps) return;
      const testId = this.getCurrentTestId() ?? this.resolveTestId(step?.test ?? step?.context?.test);
      if (!testId) return;
      const startTime = this.resolveStepTime(step.startTime) ?? getTime();
      const obStep = this.client.startStep({
        testRunUUID: this.testRun!,
        testUUID: testId,
        stepName: this.getStepName(step),
        startTime,
      } as any);
      this.stepMap.set(step, obStep);
    });

    codeceptEvent.dispatcher.on(codeceptEvent.step.passed, (step: any) => {
      if (!this.realtimeSteps) return;
      const obStep = this.stepMap.get(step);
      const testId = this.getCurrentTestId() ?? this.resolveTestId(step?.test ?? step?.context?.test);
      if (!obStep || !testId) return;
      this.client.finishStep(obStep, {
        testRunUUID: this.testRun!,
        status: status.PASSED,
        endTime: this.resolveStepTime(step.endTime) ?? getTime(),
      } as any);
      this.stepMap.delete(step);
    });

    codeceptEvent.dispatcher.on(codeceptEvent.step.failed, (step: any) => {
      if (!this.realtimeSteps) return;
      const obStep = this.stepMap.get(step);
      const testId = this.getCurrentTestId() ?? this.resolveTestId(step?.test ?? step?.context?.test);
      if (testId && obStep) {
        const endTime = this.resolveStepTime(step.endTime) ?? getTime();
        const errorObj = step.err ?? step.error;
        if (errorObj) {
          for (const entry of buildErrorLogs(errorObj)) {
            this.logMessage(testId, entry.message, entry.level, obStep, entry.logFormat);
          }
        }
        // If no errorObj, do not log a placeholder to avoid "[Error] undefined"
        this.client.finishStep(obStep, {
          testRunUUID: this.testRun!,
          status: status.FAILED,
          endTime,
        } as any);
        this.stepMap.delete(step);
      }
    });

    codeceptEvent.dispatcher.on(codeceptEvent.test.after, (test: any) => {
      const paths = new Set<string>();

      const collect = (p?: string) => {
        if (typeof p === 'string' && p.toLowerCase().endsWith('.png')) {
          paths.add(this.normalizePathKey(p));
        }
      };

      if (test?.artifacts) {
        for (const value of Object.values(test.artifacts)) {
          if (typeof value === 'string') collect(value);
        }
      }

      if (Array.isArray(test?.attachments)) {
        for (const att of test.attachments) {
          collect(att as unknown as string);
        }
      }

      for (const p of paths) {
        this.track(this.attachFileToTest(test, p, `Screenshot: ${path.basename(p)}`));
      }
    });


    // ── EVENT_RUN_BEGIN ────────────────────────────────────────────────
    runner.on(Mocha.Runner.constants.EVENT_RUN_BEGIN, () => {
      this.finishedTests.clear();
      this.stepsReported.clear();
      this.stepMap.clear();
      this.testRun = this.client.startTestRun(
        getStartTestRun({
          testset: testset!,
          description: this.client.config?.description ?? this.options.description,
          attributes: this.client.config?.attributes ?? this.options.attributes,
        }),
      ) as UUID;
    });

    // ── EVENT_SUITE_BEGIN ─────────────────────────────────────────────
    runner.on(Mocha.Runner.constants.EVENT_SUITE_BEGIN, (suite: Mocha.Suite) => {
      // Skip the implicit root suite created by Mocha.
      if (suite.root || !suite.title) return;

      const { cleanTitle, attributes } = mergeSuiteAttributesFromTitle(suite?.title);

      const newSuite = this.client.startSuite({
        testRunUUID: this.testRun!,
        parentSuiteUUID: this.getCurrentSuiteId(),
        suiteNames: [cleanTitle || suite.title],
        attributes: attributes.length ? attributes : undefined,
      } as any);
      this.activeSuites.push({ tempId: newSuite[0], name: cleanTitle || suite.title, attributes });
      this.activeSuites.push({ tempId: newSuite[0], name: cleanTitle || suite.title });
    });

    // ── EVENT_SUITE_END ──────────────────────────────────────────────
    runner.on(Mocha.Runner.constants.EVENT_SUITE_END, (suite: Mocha.Suite) => {
      if (suite.root || !suite.title) return;
      this.activeSuites.pop();
    });

    // ── EVENT_TEST_BEGIN ─────────────────────────────────────────────
    runner.on(Mocha.Runner.constants.EVENT_TEST_BEGIN, (test: Mocha.Test) => {
      this.startTest(test, testEntity.TEST);
    });

    // ── EVENT_TEST_PASS ──────────────────────────────────────────────
    runner.on(Mocha.Runner.constants.EVENT_TEST_PASS, (test: Mocha.Test) => {
      const testId = this.getCurrentTestId();
      if (testId) {
        this.reportSteps(test, testId);
        this.stepsReported.add(testId);
      }
      this.finishTestItem(test, false);
    });

    // ── EVENT_TEST_FAIL ──────────────────────────────────────────────
    runner.on(Mocha.Runner.constants.EVENT_TEST_FAIL, (test: Mocha.Test, err: any) => {
      this.track(
        (async () => {
          // Ensure we have a test to attach failure to.
          let testId = this.getCurrentTestId() ?? this.resolveTestId(test);
          if (!testId) {
            testId = (this.startTest(test, testEntity.TEST) ?? null) as UUID | null;
          }

          // 1. Report CodeceptJS steps
          if (testId && !this.stepsReported.has(testId)) {
            this.reportSteps(test, testId);
            this.stepsReported.add(testId);
          }

          // 2. Report error logs
          if (testId) {
            for (const entry of buildErrorLogs(err)) {
              this.logMessage(testId, entry.message, entry.level, null, entry.logFormat);
            }
          }

          // 3. Finish test (screenshots handled in test.after)
          if (testId) this.finishTestItem(test, false, status.FAILED, testId);
        })(),
      );
    });

    // Fallback: ensure any test ends with the correct status if not already finished.
    runner.on(Mocha.Runner.constants.EVENT_TEST_END, (test: Mocha.Test) => {
      const stackId = this.getCurrentTestId();
      const testId = stackId ?? this.resolveTestId(test);
      if (!testId || this.finishedTests.has(testId)) return;
      if (!this.stepsReported.has(testId)) {
        this.reportSteps(test, testId);
        this.stepsReported.add(testId);
      }
      const finalStatus =
        test.state === 'failed' || test.err ? status.FAILED : test.pending ? status.SKIPPED : status.PASSED;
      this.finishTestItem(test, test.pending, finalStatus, testId);

      // pop the stack if it matches current
      if (stackId && this.activeTests.length && this.activeTests[this.activeTests.length - 1].tempId === stackId) {
        this.activeTests.pop();
      }
    });

    // ── EVENT_TEST_PENDING ───────────────────────────────────────────
    runner.on(Mocha.Runner.constants.EVENT_TEST_PENDING, (test: Mocha.Test) => {
      // Pending (skipped) tests never receive TEST_BEGIN, so start one now.
      if (!this.getCurrentTestId()) {
        this.startTest(test, testEntity.TEST);
      }
      this.finishTestItem(test, true);
    });


    // ── EVENT_RUN_END ────────────────────────────────────────────────
    runner.on(Mocha.Runner.constants.EVENT_RUN_END, async () => {
      // Wait for any in-flight async work (screenshot reads, etc.)
      await this.awaitInflight();

      if (this.testRun) {
        await this.client.finishTestRun(this.testRun, {
          endTime: getTime(),
        } as any);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════

  private getCurrentSuiteId(): UUID | null {
    return this.activeSuites.length
      ? this.activeSuites[this.activeSuites.length - 1].tempId
      : null;
  }

  private getCurrentSuiteAttributes(): any[] {
    return this.activeSuites.length
      ? this.activeSuites[this.activeSuites.length - 1].attributes ?? []
      : [];
  }

  private getCurrentTestId(): UUID | null {
    return this.activeTests.length
      ? this.activeTests[this.activeTests.length - 1].tempId
      : null;
  }

  // ── Test lifecycle ─────────────────────────────────────────────────

  private startTest(test: any, type: string): UUID | undefined {
    if (this.disabled) return undefined;
    const parent = this.getCurrentSuiteId();
    if (!parent) return undefined;
    const data = this.extractData(test);
    const titleWithoutData = this.stripDataFromTitle(test?.title);
    const { cleanTitle, attributes } = mergeAttributesFromEntityAndTitle({ ...test, title: titleWithoutData });
    const suiteAttributes = this.getCurrentSuiteAttributes();

    const baseKey = cleanTitle || titleWithoutData || test?.title || '';
    let iterationSuffix = '';
    if (data) {
      const next = (this.iterationCounter.get(baseKey) ?? 0) + 1;
      this.iterationCounter.set(baseKey, next);
      iterationSuffix = ` #${next}`;
    }
    const finalTitle = `${cleanTitle}${iterationSuffix}`;

    const newTest = this.client.startTest({
      testRunUUID: this.testRun!,
      suiteUUID: parent,
      testName: finalTitle,
      testType: type,
      startTime: getTime(),
      attributes: [...suiteAttributes, ...attributes].length > 0 ? [...suiteAttributes, ...attributes] : undefined,
    } as any);
    this.activeTests.push({ tempId: newTest, name: finalTitle });
    this.indexTestId({ ...test, title: finalTitle }, newTest, [test?.title, titleWithoutData, finalTitle]);

    if (this.logDataAsMarkdown && data && typeof data === 'object') {
      const msg = `**Data**\n\n${formatAsMarkdownJson(data)}`;
      this.logMessage(newTest, msg, level.INFO, null, 'MARKDOWN');
    }
    return newTest;
  }

  private finishTestItem(test: any, skipped = false, forcedStatus?: string, explicitTestId?: UUID | null): void {
    if (this.disabled) return;
    const testId = explicitTestId ?? this.getCurrentTestId() ?? this.resolveTestId(test);
    if (!testId) return;
    if (this.finishedTests.has(testId)) return;
    if (!this.stepsReported.has(testId)) {
      this.reportSteps(test, testId);
      this.stepsReported.add(testId);
    }
    const testStatus =
      forcedStatus ??
      (skipped || test.pending
        ? status.SKIPPED
        : test.state === 'failed' || test.err
          ? status.FAILED
          : status.PASSED);

    this.client.finishTest(testId, {
      testRunUUID: this.testRun!,
      status: testStatus,
      endTime: getTime(),
    } as any);
    this.finishedTests.add(testId);

    // remove matching test from stack if present
    const idx = this.activeTests.findIndex((t) => t.tempId === testId);
    if (idx >= 0) this.activeTests.splice(idx, 1);
  }

  // ── CodeceptJS step reporting ──────────────────────────────────────

  /**
   * After a test finishes, iterate its `steps` array (populated by
   * CodeceptJS at runtime) and report each step to Orangebeard.
   */
  private reportSteps(test: any, testId: UUID): void {
    if (this.realtimeSteps) return;
    const steps: any[] = test.steps ?? [];

    for (const step of steps) {
      const stepName = this.getStepName(step);
      const startTime = this.resolveStepTime(step.startTime) ?? getTime();

      const stepId = this.client.startStep({
        testRunUUID: this.testRun!,
        testUUID: testId,
        stepName,
        startTime,
      } as any);

      const endTime = this.resolveStepTime(step.endTime) ?? getTime();
      const stepStatus = step.status === 'failed' ? status.FAILED : status.PASSED;

      // If the step failed, log the error under the step.
      if (step.status === 'failed' && step.err) {
        for (const entry of buildErrorLogs(step.err)) {
          this.logMessage(testId, entry.message, entry.level, stepId, entry.logFormat);
        }
      }

      this.client.finishStep(stepId, {
        testRunUUID: this.testRun!,
        status: stepStatus,
        endTime,
      } as any);
    }
  }

  private getStepName(step: any): string {
    // Prefer CodeceptJS Step.toString() which gives e.g. 'I am on page "/"'
    if (typeof step.toString === 'function') {
      const str = step.toString();
      if (str && str !== '[object Object]') return str;
    }

    // Fallback: construct from parts
    const actor = step.actor ?? 'I';
    const name = typeof step.humanize === 'function' ? step.humanize() : step.name ?? 'step';
    return `${actor} ${name}`;
  }

  private resolveStepTime(time: any): string | null {
    if (typeof time === 'number' && time > 0) return getTimeFromMs(time);
    if (time instanceof Date) return getTimeFromMs(time.getTime());
    return null;
  }

  private stripDataFromTitle(title: string | undefined): string {
    if (!title) return '';
    const idx = title.indexOf(' | {');
    if (idx > -1) {
      return title.slice(0, idx).trim();
    }
    return title;
  }

  private extractData(test: any): any | null {
    const fromTitle = this.parseDataFromTitle(test?.title);
    const candidates = [
      test?.ctx?.current,
      test?.current,
      test?.ctx?.data,
      test?.data,
      test?.ctx?.test?.data,
      test?.ctx?.test?.params,
      test?.params,
      test?.ctx?.currentTest?.ctx?.data,
    ];
    for (const c of candidates) {
      if (c && typeof c === 'object') return c;
    }
    return fromTitle;
  }

  private parseDataFromTitle(title: string | undefined): any | null {
    if (!title) return null;
    const idx = title.indexOf(' | {');
    if (idx === -1) return null;
    const jsonPart = title.slice(idx + 3).trim();
    const trimmed = jsonPart.endsWith('}') ? jsonPart : jsonPart.replace(/.*?({.*)/, '$1');
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  // ── Logging & attachments ──────────────────────────────────────────

  private logMessage(
    testId: UUID | null,
    message: string,
    logLevel: string,
    stepId: UUID | null = null,
    logFormat: 'PLAIN_TEXT' | 'MARKDOWN' = 'PLAIN_TEXT',
  ): UUID {
    if (this.disabled || !testId) return '' as unknown as UUID;

    return this.client.log({
      testRunUUID: this.testRun!,
      testUUID: testId,
      stepUUID: stepId ?? undefined,
      logTime: getTime(),
      message,
      logLevel,
      logFormat,
    } as any) as UUID;
  }

  private logAttachment(
    testId: UUID | null,
    logId: UUID,
    attachment: { name: string; contentType: string; content: Buffer },
    stepId: UUID | null = null,
  ): void {
    if (this.disabled || !testId) return;

    const payload: Attachment = {
      file: attachment,
      metaData: {
        testRunUUID: this.testRun!,
        testUUID: testId,
        logUUID: logId,
        stepUUID: stepId ?? undefined,
        attachmentTime: getTime(),
      },
    };

    this.client.sendAttachment(payload);
  }

  // ── Screenshot handling ────────────────────────────────────────────

  /**
   * Attach a failure screenshot to the current test.
   *
   * CodeceptJS's built-in `screenshotOnFail` plugin stores the screenshot
   * path in `test.artifacts.screenshot`.
   */
  private async reportScreenshot(test: any): Promise<void> {
    const screenshotPath: string | undefined = test.artifacts?.screenshot;
    if (!screenshotPath) return;
    const testId = this.getCurrentTestId() ?? this.resolveTestId(test);
    if (!testId) return;

    await this.attachFileToTest(test, screenshotPath, `Screenshot: ${path.basename(screenshotPath)}`);
  }

  // Attach any file path to the test (best-effort)
  private async attachFileToTest(test: any, filePath: string, message: string): Promise<boolean> {
    const testId = this.resolveTestId(test);
    if (!testId) return false;
    const resolved = this.normalizePathKey(filePath);
    if (this.uploadedAttachments.has(resolved)) return false;

    try {
      const content = await getBytes(filePath);
      const attachment = {
        name: path.basename(filePath),
        contentType: 'image/png',
        content,
      };
      const logId = this.logMessage(testId, message, level.INFO);
      this.logAttachment(testId, logId, attachment);
      this.uploadedAttachments.add(resolved);
      return true;
    } catch {
      // ignore if file missing/unreadable
      return false;
    }
  }

  private normalizePathKey(p: string): string {
    return path.resolve(p).replace(/\\/g, '/').toLowerCase();
  }

  private indexTestId(test: any, uuid: UUID, extraTitles: Array<string | undefined> = []): void {
    const keys = [test?.id, test?.uuid, test?.title, ...extraTitles];
    for (const k of keys) {
      if (typeof k === 'string' && k.trim()) this.testIdMap.set(k.trim(), uuid);
    }
  }

  private resolveTestId(test: any): UUID | null {
    const current = this.getCurrentTestId();
    if (current) return current;
    const titleWithoutData = this.stripDataFromTitle(test?.title);
    const { cleanTitle } = mergeAttributesFromEntityAndTitle({ ...test, title: titleWithoutData });
    const keys = [test?.id, test?.uuid, test?.title, cleanTitle, titleWithoutData];
    for (const k of keys) {
      if (typeof k === 'string' && k.trim() && this.testIdMap.has(k)) {
        return this.testIdMap.get(k)!;
      }
    }
    return null;
  }

  // ── Configuration resolution ───────────────────────────────────────

  private resolveTestset(): string | null {
    const fromClient = this.client?.config?.testset;
    if (typeof fromClient === 'string' && fromClient.trim().length > 0) return fromClient.trim();

    const fromOptions = this.options?.testset;
    if (typeof fromOptions === 'string' && fromOptions.trim().length > 0) return fromOptions.trim();

    const fromEnv = process.env.ORANGEBEARD_TESTSET;
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();

    return null;
  }

  // ── Async work tracking ────────────────────────────────────────────

  private track<T>(promise: Promise<T>): void {
    if (this.disabled) return;

    this.inflight.add(promise);
    promise.finally(() => {
      this.inflight.delete(promise);
    });
  }

  private async awaitInflight(): Promise<void> {
    if (this.disabled) return;

    while (this.inflight.size > 0) {
      const pending = Array.from(this.inflight);
      await Promise.allSettled(pending);
    }
  }
}
