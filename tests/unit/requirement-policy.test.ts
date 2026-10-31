import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkRequirementTraceability } from '../../scripts/check-requirement-traceability.mjs';
import { inspectCommitMessage } from '../../scripts/check-commit-message.mjs';

const currentVersion = (
  JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
).version;

describe('engineering requirement policy', () => {
  it('validates the current registry and linked design/test documents', () => {
    const result = checkRequirementTraceability();
    expect(result.errors).toEqual([]);
    expect(result.version).toBe(currentVersion);
    expect(result.requirements.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining([
        'REQ-TUI-001',
        'REQ-PATCH-001',
        'REQ-ENG-001',
        'REQ-ENG-002',
      ])
    );
  });

  it('accepts a commit with requirement, version, design, tests and evidence', () => {
    const result = inspectCommitMessage(`docs(REQ-ENG-002): add agent instructions

Add the repository-level agent contract.

Requirement: REQ-ENG-002
Version: ${currentVersion}
Design: docs/engineering-versioning-and-traceability.html#agent-instructions
Tests: docs/engineering-versioning-and-traceability.html#verification
Test-Evidence: npm run check
`);
    expect(result.errors).toEqual([]);
    expect(result.requirementIds).toEqual(['REQ-ENG-002']);
  });

  it('rejects orphan or incompletely documented commits', () => {
    const result = inspectCommitMessage(`fix: repair it

Version: 9.9.9
Test-Evidence: trust me
`);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('subject must be'),
        expect.stringContaining('Version trailer 9.9.9'),
        expect.stringContaining('Design trailer is required'),
        expect.stringContaining('Tests trailer is required'),
      ])
    );
  });
});
