import type {
  PromptBuildContext,
  PromptSection,
} from '../prompt-context';

export function sandboxPolicySection(
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
        'Host policy: isolated sandbox.',
        '- Work inside the declared sandbox boundary.',
        '- Network restrictions, mounts, resource limits, and approvals are runtime policy.',
        '- Report missing dependencies instead of weakening or disabling isolation.',
        '- Run relevant tests and type checks through registered sandbox capabilities before declaring completion.',
      ].join('\n'),
  };
}
