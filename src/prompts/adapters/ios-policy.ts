import type {
  PromptBuildContext,
  PromptSection,
} from '../prompt-context';

export function iosPolicySection(_context: PromptBuildContext): PromptSection {
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
        'Host policy: iOS native bridge.',
        '- Use only bridged File, Blob, Secret, and other registered capabilities.',
        '- Do not assume process spawning or locally installed binaries exist.',
        '- Keep secrets in runtime-owned leases and never repeat them in prompts, logs, or final answers.',
      ].join('\n'),
  };
}
