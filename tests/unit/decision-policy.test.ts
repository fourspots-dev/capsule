import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDecisionRegistry } from '../../scripts/check-decision-registry.mjs';

describe('REQ-ENG-006 decision intake policy', () => {
  it('validates DEC-001 promoted to ADR-013 and REQ-ENG-006', () => {
    const result = checkDecisionRegistry();
    expect(result.errors).toEqual([]);
    const decision = result.decisions.find(
      (item: { id: string }) => item.id === 'DEC-001'
    ) as
      | {
          status: string;
          triage: { adrs: string[]; requirements: string[] };
        }
      | undefined;
    expect(decision?.status).toBe('promoted');
    expect(decision?.triage.adrs).toEqual(['ADR-013']);
    expect(decision?.triage.requirements).toEqual(['REQ-ENG-006']);
  });

  it('allows a captured discussion decision before a REQ exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinyai-dec-captured-'));
    try {
      await prepareRegistries(root, {
        decisions: [
          {
            id: 'DEC-001',
            title: 'Captured decision',
            statement: 'A durable decision made during discussion.',
            normalizedDecision: 'Keep the rule for future work.',
            capturedAt: '2026-11-01',
            source: 'discussion',
            scope: ['architecture'],
            status: 'captured',
            triage: null,
            supersedes: [],
            supersededBy: null,
            file: 'docs/decisions/DEC-001-captured-decision.md',
          },
        ],
      });
      await writeDecisionDocument(
        root,
        'DEC-001-captured-decision.md',
        decisionDocument({
          id: 'DEC-001',
          title: 'Captured decision',
          status: 'captured',
          triage: 'pending',
          adrs: [],
          requirements: [],
        })
      );
      expect(checkDecisionRegistry(root).errors).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unknown promotion targets and a broken ADR backlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinyai-dec-links-'));
    try {
      await prepareRegistries(root, {
        decisions: [
          {
            id: 'DEC-001',
            title: 'Broken promotion',
            statement: 'Statement.',
            normalizedDecision: 'Normalized.',
            capturedAt: '2026-11-01',
            source: 'discussion',
            scope: ['architecture'],
            status: 'promoted',
            triage: {
              disposition: 'adr_and_requirement',
              adrs: ['ADR-999'],
              requirements: ['REQ-ENG-999'],
              rationale: 'Broken references.',
            },
            supersedes: [],
            supersededBy: null,
            file: 'docs/decisions/DEC-001-broken-promotion.md',
          },
        ],
      });
      await writeDecisionDocument(
        root,
        'DEC-001-broken-promotion.md',
        decisionDocument({
          id: 'DEC-001',
          title: 'Broken promotion',
          status: 'promoted',
          triage: 'adr_and_requirement',
          adrs: ['ADR-999'],
          requirements: ['REQ-ENG-999'],
        })
      );
      expect(checkDecisionRegistry(root).errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('unknown ADR ADR-999'),
          expect.stringContaining('unknown requirement REQ-ENG-999'),
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects metadata drift and unregistered DEC documents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinyai-dec-metadata-'));
    try {
      await prepareRegistries(root, {
        decisions: [
          {
            id: 'DEC-001',
            title: 'Metadata decision',
            statement: 'Statement.',
            normalizedDecision: 'Normalized.',
            capturedAt: '2026-11-01',
            source: 'discussion',
            scope: ['architecture'],
            status: 'withdrawn',
            triage: null,
            supersedes: [],
            supersededBy: null,
            file: 'docs/decisions/DEC-001-metadata-decision.md',
          },
        ],
      });
      await writeDecisionDocument(
        root,
        'DEC-001-metadata-decision.md',
        decisionDocument({
          id: 'DEC-001',
          title: 'Different title',
          status: 'captured',
          triage: 'adr',
          adrs: ['ADR-999'],
          requirements: [],
        })
      );
      await mkdir(join(root, 'docs/decisions'), { recursive: true });
      await writeFile(
        join(root, 'docs/decisions/DEC-002-orphan.md'),
        '# DEC-002: Orphan\n'
      );
      expect(checkDecisionRegistry(root).errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('file title does not match registry'),
          expect.stringContaining('file Status does not match registry'),
          expect.stringContaining('file Triage does not match registry'),
          expect.stringContaining('unregistered DEC file'),
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('documents proactive sweep, batching, and stop-before-coding behavior', () => {
    const agents = readFileSync('AGENTS.md', 'utf8');
    expect(agents).toContain('proactively sweep discussions');
    expect(agents).toContain('Routine decisions may be batched');
    expect(agents).toContain('stop dependent work, and wait');
    expect(agents).toContain('Never infer approval or implementation permission');
  });
});

async function prepareRegistries(
  root: string,
  registry: { decisions: Array<Record<string, unknown>> }
) {
  await mkdir(join(root, 'policy'), { recursive: true });
  await mkdir(join(root, 'docs/decisions'), { recursive: true });
  await writeFile(
    join(root, 'policy/requirement-registry.json'),
    '{"requirements":[]}'
  );
  await writeFile(
    join(root, 'policy/adr-registry.json'),
    '{"decisions":[]}'
  );
  await writeFile(
    join(root, 'policy/decision-registry.json'),
    JSON.stringify({ schemaVersion: 1, ...registry })
  );
}

async function writeDecisionDocument(
  root: string,
  name: string,
  body: string
) {
  await writeFile(join(root, 'docs/decisions', name), body);
}

function decisionDocument(input: {
  id: string;
  title: string;
  status: string;
  triage: string;
  adrs: string[];
  requirements: string[];
}) {
  return [
    `# ${input.id}: ${input.title}`,
    '',
    `- Status: ${input.status}`,
    '- Captured: 2026-11-01',
    '- Source: discussion',
    '- Scope: architecture',
    `- Triage: ${input.triage}`,
    `- ADRs: ${input.adrs.length ? input.adrs.join(', ') : 'none'}`,
    `- Requirements: ${
      input.requirements.length ? input.requirements.join(', ') : 'none'
    }`,
    '- Supersedes: none',
    '- Superseded by: none',
    '',
    '## Statement',
    '',
    'Statement.',
    '',
    '## Normalized decision',
    '',
    'Normalized.',
    '',
    '## Rationale',
    '',
    'Rationale.',
    '',
    '## Promotion',
    '',
    'Promotion.',
    '',
  ].join('\n');
}
