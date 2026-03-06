jest.mock('codeceptjs/lib/event', () => ({
  dispatcher: { on: () => undefined },
  step: { started: 'step.started', passed: 'step.passed', failed: 'step.failed', finished: 'step.finished' },
  test: { after: 'test.after' },
}), { virtual: true });
jest.mock('codeceptjs/lib/utils', () => ({
  screenshotOutputFolder: (name) => name,
}), { virtual: true });

const ReporterModule = require('../dist/reporter/OrangebeardCodeceptJSReporter');
const { status } = require('../dist/constants');
const OrangebeardCodeceptJSReporter = ReporterModule.default;

function createReporterStub() {
  const reporter = Object.create(OrangebeardCodeceptJSReporter.prototype);
  reporter.testRun = 'run-1';
  reporter.hookParentStep = new Map();
  reporter.hookPhase = new Map();
  reporter.commentParentStep = new Map();
  reporter.commentParentStatus = new Map();
  reporter.client = {
    startStep: () => 'step-1',
    finishStep: () => undefined,
  };
  reporter.logMessage = () => undefined;
  return reporter;
}

describe('OrangebeardCodeceptJSReporter', () => {
  it('getStepName should hide executeScript body', () => {
    const reporter = createReporterStub();
    const step = {
      actor: 'I',
      helperMethod: 'executeScript',
      args: [() => 'secret'],
      toString: () => 'I execute script () => console.log("x")',
      humanize: () => 'execute script',
    };

    const title = reporter.getStepName(step);
    expect(title).toBe('I execute script');
  });

  it('getStepName should keep HTTP url and remove payload/headers from title', () => {
    const reporter = createReporterStub();
    const step = {
      actor: 'I',
      helperMethod: 'sendPostRequest',
      args: ['https://reqres.in/api/users', { name: 'John' }, { Authorization: 'token' }],
      humanize: () => 'send post request',
    };

    const title = reporter.getStepName(step);
    expect(title).toBe('I send post request \"https://reqres.in/api/users\"');
  });

  it('isRealError should ignore non-error hook callback objects', () => {
    const reporter = createReporterStub();
    const fakeHookErrFunction = function (err) {
      return err;
    };
    expect(reporter.isRealError(fakeHookErrFunction)).toBe(false);
    expect(reporter.isRealError(new Error('boom'))).toBe(true);
    expect(reporter.isRealError({ message: 'bad' })).toBe(true);
  });

  it('closeHookParent should force PASSED when provided error is not real', () => {
    const reporter = createReporterStub();
    const calls = [];
    reporter.hookParentStep.set('t1', 'hook-step-1');
    reporter.client.finishStep = (id, payload) => calls.push({ id, payload });

    reporter.closeHookParent('t1', status.FAILED, function notReal() {});
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('hook-step-1');
    expect(calls[0].payload.status).toBe(status.PASSED);
    expect(reporter.hookParentStep.has('t1')).toBe(false);
  });

  it('ensureHookParent should create one hook parent per phase', () => {
    const reporter = createReporterStub();
    let starts = 0;
    reporter.client.startStep = () => {
      starts += 1;
      return `parent-${starts}`;
    };
    reporter.hookPhase.set('t1', 'Before');

    reporter.ensureHookParent('t1');
    reporter.ensureHookParent('t1');
    expect(starts).toBe(1);
    expect(reporter.hookParentStep.get('t1')).toBe('parent-1');
  });
});
