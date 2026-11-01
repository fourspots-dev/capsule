import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAdrRegistry } from '../../scripts/check-adr-registry.mjs';

describe('ADR policy', () => {
  it('validates the current ADR registry and supersede relationships', () => {
    const result = checkAdrRegistry();
    expect(result.errors).toEqual([]);
    expect(result.decisions.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining([
        'ADR-001',
        'ADR-003',
        'ADR-008',
        'ADR-009',
        'ADR-010',
        'ADR-011',
        'ADR-012',
        'ADR-013',
      ])
    );
  });

  it('rejects missing sections and broken supersede references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinyai-adr-'));
    try {
      await mkdir(join(root, 'policy'), { recursive: true });
      await mkdir(join(root, 'docs/adr'), { recursive: true });
      await writeFile(
        join(root, 'policy/requirement-registry.json'),
        readFileSync('policy/requirement-registry.json', 'utf8')
      );
      await writeFile(
        join(root, 'policy/decision-registry.json'),
        '{"schemaVersion":1,"decisions":[]}'
      );
      await writeFile(
        join(root, 'docs/adr/ADR-001-bad.md'),
        [
          '# ADR-001: Bad decision',
          '',
          '- Status: accepted',
          '',
          '## Context',
          '',
          'Missing required decision sections.',
          '',
        ].join('\n')
      );
      await writeFile(
        join(root, 'docs/adr/ADR-002-orphan.md'),
        '# ADR-002: Orphan\n'
      );
      await writeFile(
        join(root, 'policy/adr-registry.json'),
        JSON.stringify({
          schemaVersion: 1,
          decisions: [
            {
              id: 'ADR-001',
              title: 'Bad decision',
              status: 'accepted',
              file: 'docs/adr/ADR-001-bad.md',
              requirements: ['REQ-ENG-005'],
              originDecision: null,
              decidedAt: '2026-11-01',
              approvedBy: 'user',
              supersedes: [],
              supersededBy: 'ADR-999',
            },
          ],
        })
      );
      const result = checkAdrRegistry(root);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('missing section Decision'),
          expect.stringContaining('unregistered ADR file: docs/adr/ADR-002-orphan.md'),
          expect.stringContaining('supersededBy is only valid'),
          expect.stringContaining('supersededBy unknown ADR ADR-999'),
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects metadata drift and agent self-approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinyai-adr-metadata-'));
    try {
      await mkdir(join(root, 'policy'), { recursive: true });
      await mkdir(join(root, 'docs/adr'), { recursive: true });
      await writeFile(
        join(root, 'policy/requirement-registry.json'),
        JSON.stringify({
          requirements: [{ id: 'REQ-ENG-005' }],
        })
      );
      await writeFile(
        join(root, 'policy/decision-registry.json'),
        '{"schemaVersion":1,"decisions":[]}'
      );
      await writeFile(
        join(root, 'policy/adr-registry.json'),
        JSON.stringify({
          schemaVersion: 1,
          decisions: [
            {
              id: 'ADR-001',
              title: 'Metadata test',
              status: 'accepted',
              file: 'docs/adr/ADR-001-metadata-test.md',
              requirements: ['REQ-ENG-005'],
              originDecision: null,
              decidedAt: '2026-11-01',
              approvedBy: 'user',
              supersedes: [],
              supersededBy: null,
            },
          ],
        })
      );
      await writeFile(
        join(root, 'docs/adr/ADR-001-metadata-test.md'),
        [
          '# ADR-001: Metadata test',
          '',
          '- Status: accepted',
          '- Date: 2026-10-31',
          '- Approved by: agent',
          '- Requirements: REQ-ENG-999',
          '- Origin decision: DEC-999',
          '- Supersedes: none',
          '- Superseded by: none',
          '',
          '## Context',
          '',
          'Context.',
          '',
          '## Decision',
          '',
          'Decision.',
          '',
          '## Invariants',
          '',
          'Invariant.',
          '',
          '## Alternatives considered',
          '',
          'Alternative.',
          '',
          '## Consequences',
          '',
          'Consequence.',
          '',
          '## Affected surfaces',
          '',
          'Surface.',
          '',
          '## Verification',
          '',
          'Test.',
          '',
        ].join('\n')
      );
      const result = checkAdrRegistry(root);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('file Date does not match'),
          expect.stringContaining('file Approved by does not match'),
          expect.stringContaining('file Requirements do not match'),
          expect.stringContaining('file Origin decision does not match'),
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows an ADR without a REQ only when an origin decision is linked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinyai-adr-origin-'));
    try {
      await mkdir(join(root, 'policy'), { recursive: true });
      await mkdir(join(root, 'docs/adr'), { recursive: true });
      await writeFile(
        join(root, 'policy/requirement-registry.json'),
        '{"requirements":[]}'
      );
      await writeFile(
        join(root, 'policy/decision-registry.json'),
        JSON.stringify({
          schemaVersion: 1,
          decisions: [
            {
              id: 'DEC-001',
              triage: { adrs: ['ADR-001'] },
            },
          ],
        })
      );
      await writeFile(
        join(root, 'policy/adr-registry.json'),
        JSON.stringify({
          schemaVersion: 1,
          decisions: [
            {
              id: 'ADR-001',
              title: 'Decision-only architecture rule',
              status: 'accepted',
              file: 'docs/adr/ADR-001-decision-only.md',
              requirements: [],
              originDecision: 'DEC-001',
              decidedAt: '2026-11-01',
              approvedBy: 'user',
              supersedes: [],
              supersededBy: null,
            },
          ],
        })
      );
      await writeFile(
        join(root, 'docs/adr/ADR-001-decision-only.md'),
        [
          '# ADR-001: Decision-only architecture rule',
          '',
          '- Status: accepted',
          '- Date: 2026-11-01',
          '- Approved by: user',
          '- Requirements: none',
          '- Origin decision: DEC-001',
          '- Supersedes: none',
          '- Superseded by: none',
          '',
          '## Context',
          '',
          'Context.',
          '',
          '## Decision',
          '',
          'Decision.',
          '',
          '## Invariants',
          '',
          'Invariant.',
          '',
          '## Alternatives considered',
          '',
          'Alternative.',
          '',
          '## Consequences',
          '',
          'Consequence.',
          '',
          '## Affected surfaces',
          '',
          'Surface.',
          '',
          '## Verification',
          '',
          'Test.',
          '',
        ].join('\n')
      );
      expect(checkAdrRegistry(root).errors).toEqual([]);

      const registryPath = join(root, 'policy/adr-registry.json');
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      registry.decisions[0].originDecision = null;
      await writeFile(registryPath, JSON.stringify(registry));
      expect(checkAdrRegistry(root).errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('requires at least one requirement or originDecision'),
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
