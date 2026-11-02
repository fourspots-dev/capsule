import { describe, expect, it } from 'vitest';
import { chromePromptProfile } from '../../src/adapters/chrome-prompts';
import { workspaceEditPrompt } from '../../src/platform/workspace-edit-prompt';

describe('workspace edit prompt contract', () => {
  it('uses one patch policy across prompt profiles', () => {
    expect(workspaceEditPrompt).toContain('*** Begin Patch');
    expect(workspaceEditPrompt).toContain('Every Update hunk starts with @@');
    expect(workspaceEditPrompt).toContain('Do not calculate unified-diff line counts');
    expect(workspaceEditPrompt).toContain('apply_unified_diff');
    expect(workspaceEditPrompt).toContain('re-read the target before retrying');
    expect(
      chromePromptProfile.build({
        profile: undefined,
        skills: [],
        tools: [
          {
            name: 'apply_patch',
            description: 'Apply a workspace patch.',
            parameters: { type: 'object' },
            risk: 'write',
            effect: 'write',
            execute: async () => ({ ok: true }),
          },
          {
            name: 'apply_unified_diff',
            description: 'Apply a strict unified diff.',
            parameters: { type: 'object' },
            risk: 'write',
            effect: 'write',
            execute: async () => ({ ok: true }),
          },
        ],
      })
    ).toContain(workspaceEditPrompt);
  });
});
