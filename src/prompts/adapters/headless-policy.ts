import type {
  PromptBuildContext,
  PromptSection,
} from '../prompt-context';

export function headlessPolicySection(
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
        'Host policy: non-interactive headless execution.',
        '- Do not wait for a person to click or type. Resolve work from the request and registered capabilities.',
        '- When approval cannot be obtained, report the blocked effect and continue with safe read-only work when useful.',
        '- Return a machine-readable truth base in prose: changes, current verification, remaining work, and blockers.',
      ].join('\n'),
  };
}
