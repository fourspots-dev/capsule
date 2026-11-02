import type { PromptBuildContext, PromptSection } from './prompt-context';

export function workspacePolicySection(
  context: PromptBuildContext
): PromptSection {
  return {
    id: 'workspace-policy',
    layer: 'workspace',
    kind: 'policy',
    priority: 90,
    required: true,
    trust: 'core',
    cache: 'stable',
    render: () => renderWorkspacePolicy(context),
  };
}

function renderWorkspacePolicy(context: PromptBuildContext): string {
  const lines = [
    'Workspace rules:',
    '- Use workspace-relative paths. Never depend on or expose a host absolute path.',
    '- Workspace files are virtual resources unless a host export operation explicitly creates a host copy.',
    '- Never rewrite workspace paths as file://, data:, drive paths, Desktop paths, or Downloads paths.',
    '- Inspect relevant files and current state before editing.',
    '- Prefer the smallest coherent change and preserve unrelated user work.',
    '- Search and code-intelligence capabilities describe navigation; source files remain the authority.',
  ];
  if (context.workspaceProfile === 'portable') {
    lines.push(
      '- This is a portable workspace. Use only registered workspace, patch, search, Portable Git, and execution Actions.',
      '- Do not assume a generic binary runner exists.'
    );
  } else {
    lines.push(
      '- This is a legacy-capable workspace. Generic execution may exist only when its capability is listed.',
      '- Restricted virtual builtins are not equivalent to a full host runtime.'
    );
  }
  lines.push(
    '- Do not claim verification succeeded without a newer observed successful verification result.'
  );
  return lines.join('\n');
}
