import { describe, expect, it } from 'vitest';
import { parseTestReport } from '../../src/core/test-report';

describe('REQ-TEST-001 portable TestReport parser', () => {
  it('parses structured JSON and validates count closure', () => {
    const result = parseTestReport(
      {
        total: 4,
        passed: 3,
        failed: 1,
        skipped: 0,
        failures: [{ name: 'suite/case', message: 'expected true' }],
      },
      'vitest'
    );
    expect(result.report).toMatchObject({
      runner: 'vitest',
      total: 4,
      passed: 3,
      failed: 1,
      skipped: 0,
      failures: [{ name: 'suite/case', message: 'expected true' }],
    });
    expect(
      parseTestReport(
        { total: 2, passed: 1, failed: 0, skipped: 0 },
        'vitest'
      ).error
    ).toContain('count mismatch');
  });

  it('parses JUnit summaries and failure cases', () => {
    const result = parseTestReport(
      '<testsuite tests="3" failures="1" skipped="1"><testcase name="ok"/><testcase name="bad"><failure message="broken"/></testcase><testcase name="skip"><skipped/></testcase></testsuite>',
      'junit'
    );
    expect(result.report).toMatchObject({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      failures: [{ name: 'bad', message: 'broken' }],
    });
  });

  it('rejects zero tests, malformed reports and unsupported output', () => {
    expect(
      parseTestReport(
        { total: 0, passed: 0, failed: 0, skipped: 0 },
        'vitest'
      ).error
    ).toContain('Zero tests');
    expect(parseTestReport('plain output', 'script').error).toContain(
      'no supported'
    );
    expect(
      parseTestReport({ testReport: { total: -1 } }, 'vitest').error
    ).toBeTruthy();
  });
});
