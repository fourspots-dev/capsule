import type { ResolvedAgentProfile } from '../core/agent-profile';
import type { SkillDefinition } from '../core/extension-registry';

export interface PromptProfileContext {
  profile?: ResolvedAgentProfile;
  skills: readonly SkillDefinition[];
}

export interface PromptProfile {
  id: string;
  build(context: PromptProfileContext): string;
}
