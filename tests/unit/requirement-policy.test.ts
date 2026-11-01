import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
        'REQ-ENG-003',
        'REQ-ENG-004',
      ])
    );
  });

  it('requires architecture impact and completeness anchors for marked requirements', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinyai-requirements-'));
    try {
      await mkdir(join(root, 'policy'), { recursive: true });
      await mkdir(join(root, 'docs'), { recursive: true });
      await writeFile(join(root, 'package.json'), '{"version":"0.3.1"}');
      await writeFile(
        join(root, 'docs/design.html'),
        '<section id="requirements"></section>'
      );
      await writeFile(
        join(root, 'docs/testing.html'),
        '<section id="trace"></section>'
      );
      await writeFile(
        join(root, 'policy/requirement-registry.json'),
        JSON.stringify({
          schemaVersion: 1,
          baselineCommit: 'abcdef1',
          requirements: [
            {
              id: 'REQ-ENG-999',
              title: 'Architecture contract test',
              type: 'infrastructure',
              priority: 'P0',
              status: 'verified',
              designStatus: 'review',
              implementationAuthorized: false,
              targetVersion: '0.3.1',
              design: 'docs/design.html#requirements',
              testDesign: 'docs/testing.html#trace',
              acceptance: 'Proves architecture anchors are required.',
              legacyAliases: [],
              architectureImpact: true,
            },
          ],
        })
      );
      const result = checkRequirementTraceability(root);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('architecture-impact design anchor'),
          expect.stringContaining('architecture-completeness test anchor'),
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks implementation until design approval and explicit authorization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinyai-gate-'));
    try {
      await mkdir(join(root, 'policy'), { recursive: true });
      await mkdir(join(root, 'docs'), { recursive: true });
      await writeFile(join(root, 'package.json'), '{"version":"0.4.2"}');
      await writeFile(
        join(root, 'docs/design.html'),
        '<section id="architecture-impact"></section>'
      );
      await writeFile(
        join(root, 'docs/testing.html'),
        '<section id="architecture-completeness"></section>'
      );
      await writeFile(
        join(root, 'policy/requirement-registry.json'),
        JSON.stringify({
          schemaVersion: 1,
          baselineCommit: 'abcdef1',
          requirements: [
            {
              id: 'REQ-ENG-998',
              title: 'Implementation gate test',
              type: 'infrastructure',
              priority: 'P0',
              status: 'in_progress',
              designStatus: 'review',
              implementationAuthorized: false,
              targetVersion: '0.4.2',
              design: 'docs/design.html#architecture-impact',
              testDesign: 'docs/testing.html#architecture-completeness',
              acceptance: 'Implementation must wait for user approval.',
              legacyAliases: [],
              architectureImpact: true,
            },
          ],
        })
      );
      const result = checkRequirementTraceability(root);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('designStatus must be approved'),
          expect.stringContaining('implementationAuthorized must be true'),
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
