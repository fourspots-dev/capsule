import type { PromptProfile } from '../platform/prompt-profile';
import { buildPrompt } from '../prompts';

/** @deprecated Use buildPrompt with hostProfile=chrome. */
export const chromePromptProfile: PromptProfile = {
  id: 'chrome-browser',
  build({ profile, skills, tools = [] }) {
    return buildPrompt({
      hostProfile: 'chrome',
      workspaceProfile: 'portable',
      mode: 'build',
      tools,
      skills,
      ...(profile ? { agentProfile: profile } : {}),
    }).fullPrompt;
  },
};
