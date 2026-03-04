export const status = {
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  STOPPED: 'STOPPED',
  TIMED_OUT: 'TIMED_OUT',
} as const;

export const level = {
  ERROR: 'ERROR',
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
} as const;

export const testEntity = {
  SUITE: 'SUITE',
  TEST: 'TEST',
  STEP: 'STEP',
  BEFORE: 'BEFORE',
  AFTER: 'AFTER',
} as const;
