import type { ResolvedAgentProfile } from '../core/agent-profile';
import type { SkillDefinition } from '../core/extension-registry';
import type { JsonValue, ToolDefinition } from '../core/types';
import type { CodeIntelligenceCapabilities } from '../platform/code-intelligence';
import type { AvailableHostAction } from '../platform/host-action';

export type PromptHostProfile =
  | 'chrome'
  | 'tui'
  | 'headless'
  | 'ios'
  | 'sandbox';

export type PromptWorkspaceProfile = 'portable' | 'legacy';

export type PromptMode =
  | 'plan'
  | 'build'
  | 'edit'
  | 'read-only'
  | 'research'
  | 'review'
  | 'debug'
  | 'guarded'
  | 'sandbox-auto';

export type PromptSectionKind =
  | 'policy'
  | 'instructions'
  | 'capabilities'
  | 'runtime';

export type PromptTrust =
  | 'core'
  | 'project'
  | 'profile'
  | 'skill'
  | 'runtime-data';

export type PromptCacheClass = 'stable' | 'session' | 'request';

export type PromptLayer =
  | 'core'
  | 'workspace'
  | 'host'
  | 'execution'
  | 'mode'
  | 'profile'
  | 'project'
  | 'capabilities'
  | 'skill'
  | 'runtime';

export interface PromptBuildContext {
  hostProfile: PromptHostProfile;
  workspaceProfile: PromptWorkspaceProfile;
  mode: PromptMode;
  agentProfile?: ResolvedAgentProfile;
  projectInstructions?: string;
  tools: readonly ToolDefinition[];
  actions?: readonly AvailableHostAction[];
  codeIntelligence?: CodeIntelligenceCapabilities;
  skills?: readonly SkillDefinition[];
  selectedSkill?: SkillDefinition;
  runtime?: Readonly<Record<string, JsonValue | undefined>>;
  budget?: PromptBudget;
}

export interface PromptBudget {
  maxCharacters: number;
}

export interface PromptSection {
  id: string;
  layer: PromptLayer;
  kind: PromptSectionKind;
  priority: number;
  required: boolean;
  trust: PromptTrust;
  cache: PromptCacheClass;
  render(context: PromptBuildContext): string;
}

export interface RenderedPromptSection {
  id: string;
  layer: PromptLayer;
  kind: PromptSectionKind;
  priority: number;
  trust: PromptTrust;
  cache: PromptCacheClass;
  characters: number;
  estimatedTokens: number;
  truncated: boolean;
}

export interface PromptManifest {
  version: 1;
  hostProfile: PromptHostProfile;
  workspaceProfile: PromptWorkspaceProfile;
  mode: PromptMode;
  capabilityFingerprint: string;
  cacheKey: string;
  totalCharacters: number;
  estimatedTokens: number;
  sections: RenderedPromptSection[];
  omittedSections: string[];
}

export interface PromptEnvelope {
  stablePrefix: string;
  sessionContext: string;
  requestContext: string;
  fullPrompt: string;
  manifest: PromptManifest;
}
