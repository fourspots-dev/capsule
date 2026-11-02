import type {
  PromptBuildContext,
  PromptSection,
} from '../prompt-context';

export function chromePolicySection(
  _context: PromptBuildContext
): PromptSection {
  return {
    id: 'host-policy',
    layer: 'host',
    kind: 'policy',
    priority: 85,
    required: true,
    trust: 'core',
    cache: 'stable',
    render: () =>
      [
        'Host policy: Chrome extension.',
        '- Work only inside the current workspace tab group. Do not operate on unrelated tabs.',
        '- activeTabId is the tab the user is viewing. executionTabId is the tab bound to the current task.',
        '- Viewing another tab in the group does not by itself change executionTabId or the Session.',
        '- When the user explicitly asks to work on the currently viewed tab, change executionTabId through the registered tab-switch capability before acting.',
        '- Ground page work in observed page structure and text. Use screenshots only when visual appearance matters.',
        '- After changing a page, reload or inspect the result and report browser errors honestly.',
        '- Workspace files are storage-backed virtual files. Use open_workspace_file for preview and verify_workspace_file for generation-bound checks.',
        '- Use export_workspace_file before claiming that a file can be opened outside tinyai.',
        '- Do not inject a workspace source file into an unrelated page as a preview substitute.',
      ].join('\n'),
  };
}
