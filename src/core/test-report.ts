import type { JsonValue } from './types';

export interface TestFailure {
  name: string;
  message?: string;
  artifactIds?: string[];
}

export interface TestReport {
  schemaVersion: 1;
  runner: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: TestFailure[];
  startedAt?: number;
  completedAt?: number;
}

export interface ParsedTestReport {
  report?: TestReport;
  error?: string;
}

export function parseTestReport(
  value: JsonValue | undefined,
  fallbackRunner: string
): ParsedTestReport {
  const candidate = findCandidate(value);
  if (candidate === undefined) {
    return {
      error: `No structured TestReport was found for ${fallbackRunner}`,
    };
  }
  const parsed =
    typeof candidate === 'string'
      ? parseReportString(candidate, fallbackRunner)
      : parseReportObject(candidate, fallbackRunner);
  if (!parsed.report) return parsed;
  const { report } = parsed;
  if (
    report.total < 0 ||
    report.passed < 0 ||
    report.failed < 0 ||
    report.skipped < 0
  ) {
    return { error: 'TestReport counts must be non-negative' };
  }
  if (report.total !== report.passed + report.failed + report.skipped) {
    return {
      error: `TestReport count mismatch: total=${report.total}, passed=${report.passed}, failed=${report.failed}, skipped=${report.skipped}`,
    };
  }
  if (report.total === 0) {
    return { error: 'Zero tests do not prove completion' };
  }
  return { report };
}

function findCandidate(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return undefined;
  if (!value || typeof value !== 'object') return undefined;
  for (const key of ['testReport', 'test_report', 'report', 'junit']) {
    const candidate = value[key];
    if (candidate !== undefined) return candidate;
  }
  if (
    typeof value.total === 'number' ||
    typeof value.tests === 'number'
  ) {
    return value;
  }
  for (const key of ['stdout', 'stderr', 'output']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return undefined;
}

function parseReportString(value: string, runner: string): ParsedTestReport {
  const trimmed = value.trim();
  if (!trimmed) return { error: 'Test output is empty' };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as JsonValue;
      return parseReportObject(parsed, runner);
    } catch {
      return { error: 'Test output contains malformed JSON' };
    }
  }
  if (trimmed.includes('<testsuite') || trimmed.includes('<testsuites')) {
    return parseJunit(trimmed, runner);
  }
  return { error: 'Test output has no supported JSON or JUnit report' };
}

function parseReportObject(value: JsonValue, runner: string): ParsedTestReport {
  if (Array.isArray(value) || !value || typeof value !== 'object') {
    return { error: 'TestReport must be an object' };
  }
  const nested = value.testReport ?? value.test_report ?? value.report;
  if (nested !== undefined && nested !== value) {
    return parseReportObject(nested, runner);
  }
  const total = numberValue(value.total ?? value.tests);
  if (total === undefined) {
    return { error: 'TestReport is missing total/tests' };
  }
  const failed = numberValue(value.failed ?? value.failuresCount) ?? 0;
  const skipped = numberValue(value.skipped ?? value.pending) ?? 0;
  const passed =
    numberValue(value.passed) ?? Math.max(0, total - failed - skipped);
  const failures = Array.isArray(value.failures)
    ? value.failures.flatMap((failure) => {
        if (!failure || typeof failure !== 'object' || Array.isArray(failure)) {
          return [];
        }
        const name =
          typeof failure.name === 'string'
            ? failure.name
            : typeof failure.test === 'string'
              ? failure.test
              : 'failed test';
        return [
          {
            name,
            ...(typeof failure.message === 'string'
              ? { message: failure.message }
              : {}),
            ...(Array.isArray(failure.artifactIds)
              ? { artifactIds: failure.artifactIds.map(String) }
              : {}),
          },
        ];
      })
    : [];
  return {
    report: {
      schemaVersion: 1,
      runner:
        typeof value.runner === 'string' && value.runner.trim()
          ? value.runner
          : runner,
      total,
      passed,
      failed,
      skipped,
      failures,
      ...(numberValue(value.startedAt) === undefined
        ? {}
        : { startedAt: numberValue(value.startedAt) }),
      ...(numberValue(value.completedAt) === undefined
        ? {}
        : { completedAt: numberValue(value.completedAt) }),
    },
  };
}

function parseJunit(value: string, runner: string): ParsedTestReport {
  const suiteAttributes = readAttributes(
    value.match(/<testsuite\b([^>]*)>/)?.[1] ??
      value.match(/<testsuites\b([^>]*)>/)?.[1] ??
      ''
  );
  const total = Number(suiteAttributes.tests ?? 0);
  const failed = Number(suiteAttributes.failures ?? 0);
  const skipped =
    Number(suiteAttributes.skipped ?? 0) +
    Number(suiteAttributes.disabled ?? 0);
  const errors = Number(suiteAttributes.errors ?? 0);
  const failures = [
    ...value.matchAll(
      /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g
    ),
  ]
    .filter((match) => /<failure\b|<error\b/.test(match[2] ?? ''))
    .map((match) => ({
      name:
        readAttributes(match[1]).name ??
        readAttributes(match[1]).classname ??
        'failed test',
      ...((match[2] ?? '').match(
        /<(?:failure|error)\b[^>]*message="([^"]*)"/
      )?.[1]
        ? {
            message: decodeXml(
              (match[2] ?? '').match(
                /<(?:failure|error)\b[^>]*message="([^"]*)"/
              )![1]
            ),
          }
        : {}),
    }));
  return {
    report: {
      schemaVersion: 1,
      runner,
      total,
      passed: Math.max(0, total - failed - errors - skipped),
      failed: failed + errors,
      skipped,
      failures,
    },
  };
}

function readAttributes(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of value.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    result[match[1]] = decodeXml(match[2]);
  }
  return result;
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
