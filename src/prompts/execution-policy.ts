import { workspaceEditPrompt } from '../platform/workspace-edit-prompt';
import type { ToolDefinition } from '../core/types';
import type {
  PromptBuildContext,
  PromptSection,
} from './prompt-context';

export function executionPolicySection(
  context: PromptBuildContext
): PromptSection {
  return {
    id: 'execution-policy',
    layer: 'execution',
    kind: 'capabilities',
    priority: 70,
    required: true,
    trust: 'core',
    cache: 'session',
    render: () => renderExecutionPolicy(context),
  };
}

function renderExecutionPolicy(context: PromptBuildContext): string {
  const tools = permittedTools(context);
  const toolNames = new Set(tools.map((tool) => tool.name));
  const lines = ['Execution capabilities derived from the active registries:'];
  if (tools.length) {
    lines.push('Available tools:');
    for (const tool of tools) {
      lines.push(`- ${tool.name}: ${boundedOneLine(tool.description, 220)}`);
    }
  } else {
    lines.push('- No tools are currently available.');
  }

  const actionIds = [
    ...new Set([
      ...(context.actions ?? []).map((action) => action.descriptor.id),
      ...tools
        .filter((tool) => tool.name.startsWith('action_'))
        .map((tool) => tool.name.slice('action_'.length)),
    ]),
  ].sort();
  lines.push(
    actionIds.length
      ? `Application Actions: ${actionIds.join(', ')}. Use the Action listing capability for current schemas and availability.`
      : 'No application Actions are available. Do not invent command or test execution.'
  );

  if (context.codeIntelligence) {
    const intelligence = context.codeIntelligence;
    lines.push(
      `Code intelligence provider: ${intelligence.provider}. ${
        intelligence.limitations.length
          ? intelligence.limitations.join('; ')
          : 'Semantic capabilities are available.'
      }`
    );
  }

  const patchLines = patchPolicyLines(toolNames);
  if (patchLines.length) lines.push('Workspace edit protocol:', ...patchLines);
  return lines.join('\n');
}

export function permittedTools(
  context: PromptBuildContext
): readonly ToolDefinition[] {
  const profile = context.agentProfile;
  if (!profile) return uniqueTools(context.tools);
  const allowed = new Set(profile.tools.allow ?? []);
  const denied = new Set([
    ...(profile.tools.deny ?? []),
    ...profile.effectivePermissions.deniedTools,
  ]);
  return uniqueTools(context.tools).filter((tool) => {
    if (denied.has(tool.name)) return false;
    if (allowed.size && !allowed.has(tool.name)) return false;
    return (tool.capabilities ?? []).every((capability) =>
      profile.effectivePermissions.capabilities.includes(capability)
    );
  });
}

function patchPolicyLines(toolNames: ReadonlySet<string>): string[] {
  const hasPatch = toolNames.has('apply_patch');
  const hasUnifiedDiff = toolNames.has('apply_unified_diff');
  if (!hasPatch && !hasUnifiedDiff) return [];
  return workspaceEditPrompt
    .split('\n')
    .filter((line) => hasUnifiedDiff || !line.includes('apply_unified_diff'))
    .filter((line) => hasPatch || !line.includes('apply_patch'));
}

function uniqueTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return [...new Map(tools.map((tool) => [tool.name, tool])).values()];
}

function boundedOneLine(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}
