import { describe, expect, it } from 'vitest';
import { checkRequirementTraceability } from '../../scripts/check-requirement-traceability.mjs';
import { inspectCommitMessage } from '../../scripts/check-commit-message.mjs';

describe('engineering requirement policy', () => {
  it('validates the current registry and linked design/test documents', () => {
    const result = checkRequirementTraceability();
    expect(result.errors).toEqual([]);
    expect(result.version).toBe('0.2.0');
    expect(result.requirements.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining([
        'REQ-TUI-001',
        'REQ-PATCH-001',
        'REQ-ENG-001',
      ])
    );
  });

  it('accepts a commit with requirement, version, design, tests and evidence', () => {
    const result = inspectCommitMessage(`feat(REQ-ENG-001): add traceability

Add policy and enforcement.

Requirement: REQ-ENG-001
Version: 0.2.0
Design: docs/engineering-versioning-and-traceability.html
Tests: docs/engineering-versioning-and-traceability.html#verification
Test-Evidence: npm run check
`);
    expect(result.errors).toEqual([]);
    expect(result.requirementIds).toEqual(['REQ-ENG-001']);
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
