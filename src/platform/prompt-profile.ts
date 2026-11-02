import type { ResolvedAgentProfile } from '../core/agent-profile';
import type { SkillDefinition } from '../core/extension-registry';
import type { ToolDefinition } from '../core/types';

export interface PromptProfileContext {
  profile?: ResolvedAgentProfile;
  skills: readonly SkillDefinition[];
  tools?: readonly ToolDefinition[];
}

export interface PromptProfile {
  id: string;
  build(context: PromptProfileContext): string;
}
