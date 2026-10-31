import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSemver, requireDocument } from './check-requirement-traceability.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = fileURLToPath(import.meta.url);
if (resolve(process.argv[1] ?? '') === scriptPath) {
  const messagePath = process.argv[2];
  if (!messagePath) {
    process.stderr.write('Usage: node scripts/check-commit-message.mjs <message-file>\n');
    process.exitCode = 2;
  } else {
    const result = inspectCommitMessage(readFileSync(messagePath, 'utf8'));
    if (result.errors.length) {
      process.stderr.write(
        [
          'Commit message rejected:',
          ...result.errors.map((error) => `- ${error}`),
        ].join('\n') + '\n'
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(`Commit message OK: ${result.requirementIds.join(', ')}\n`);
    }
  }
}

export function inspectCommitMessage(rawMessage, projectRoot = root) {
  const lines = rawMessage
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'));
  const firstLine = lines.find((line) => line.trim()) ?? '';
  const subject = /^(feat|fix|refactor|perf|test|docs|build|ci|chore|revert)\(([^)]+)\): .+/.exec(
    firstLine
  );
  const errors = [];
  if (!subject) {
    errors.push(
      'subject must be "<type>(REQ-AREA-NNN): summary"'
    );
  }
  const subjectIds = subject
    ? subject[2]
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const registry = JSON.parse(
      readFileSync(resolve(projectRoot, 'policy/requirement-registry.json'), 'utf8')
  );
  const requirements = new Map(
    registry.requirements.map((requirement) => [requirement.id, requirement])
  );
  const packageVersion = JSON.parse(
    readFileSync(resolve(projectRoot, 'package.json'), 'utf8')
  ).version;
  const trailers = parseTrailers(lines);
  const trailerIds = splitList(trailers.Requirement);
  if (!subjectIds.length) errors.push('subject must reference at least one REQ id');
  for (const id of subjectIds) {
    if (!requirements.has(id)) errors.push(`unknown requirement ${id}`);
  }
  if (
    subjectIds.length !== trailerIds.length ||
    subjectIds.some((id) => !trailerIds.includes(id))
  ) {
    errors.push('Requirement trailer must match subject requirement ids');
  }
  if (trailers.Version !== packageVersion) {
    errors.push(
      `Version trailer ${trailers.Version ?? '<missing>'} must match package.json ${packageVersion}`
    );
  }
  if (!isSemver(trailers.Version)) errors.push('Version trailer must be A.B.C');
  if (!trailers['Test-Evidence']) {
    errors.push('Test-Evidence trailer is required');
  }
  const designPaths = splitList(trailers.Design);
  const testPaths = splitList(trailers.Tests);
  if (!designPaths.length) errors.push('Design trailer is required');
  if (!testPaths.length) errors.push('Tests trailer is required');
  for (const path of designPaths) {
    requireDocument(path, `Design ${path}`, projectRoot, errors);
  }
  for (const path of testPaths) {
    requireDocument(path, `Tests ${path}`, projectRoot, errors);
  }
  for (const id of trailerIds) {
    const requirement = requirements.get(id);
    if (!requirement) continue;
    if (!designPaths.includes(requirement.design)) {
      errors.push(`Design trailer must include ${requirement.design} for ${id}`);
    }
    if (!testPaths.includes(requirement.testDesign)) {
      errors.push(`Tests trailer must include ${requirement.testDesign} for ${id}`);
    }
  }
  return { errors, requirementIds: subjectIds };
}

function parseTrailers(lines) {
  const trailers = {};
  for (const line of lines) {
    const match = /^([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (match) trailers[match[1]] = match[2].trim();
  }
  return trailers;
}

function splitList(value) {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}
