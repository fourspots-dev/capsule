import type { PromptBuildContext, PromptSection } from './prompt-context';

const MODE_TEXT: Record<PromptBuildContext['mode'], string> = {
  plan:
    'Plan mode: inspect and reason about the task, then present an actionable plan. Do not make mutations.',
  build:
    'Build mode: implement the requested change, verify it, and report evidence and residual risk.',
  edit:
    'Edit mode: make the requested workspace edits and verify them. Runtime policy still governs risky or executable actions.',
  'read-only':
    'Read-only mode: investigate and explain without changing workspace state.',
  research:
    'Research mode: gather evidence, compare alternatives, and return findings without changing workspace state.',
  review:
    'Review mode: identify correctness, regression, security, and maintainability issues. Do not edit unless explicitly requested.',
  debug:
    'Debug mode: reproduce or isolate the failure, form a concrete hypothesis, apply the smallest fix, and rerun the strongest relevant verification.',
  guarded:
    'Guarded mode: proceed with safe reads; runtime approval governs mutations, execution, and other risky effects.',
  'sandbox-auto':
    'Sandbox-auto mode: perform permitted work autonomously inside the runtime policy. Do not treat autonomy as permission outside the sandbox.',
};

export function modePolicySection(
  context: PromptBuildContext
): PromptSection {
  return {
    id: 'mode-policy',
    layer: 'mode',
    kind: 'policy',
    priority: 75,
    required: true,
    trust: 'core',
    cache: 'session',
    render: () => MODE_TEXT[context.mode],
  };
}
