import type {
  PromptBuildContext,
  PromptSection,
} from '../prompt-context';
import { chromePolicySection } from './chrome-policy';
import { headlessPolicySection } from './headless-policy';
import { iosPolicySection } from './ios-policy';
import { sandboxPolicySection } from './sandbox-policy';
import { tuiPolicySection } from './tui-policy';

export function hostPolicySection(
  context: PromptBuildContext
): PromptSection {
  switch (context.hostProfile) {
    case 'chrome':
      return chromePolicySection(context);
    case 'tui':
      return tuiPolicySection(context);
    case 'headless':
      return headlessPolicySection(context);
    case 'ios':
      return iosPolicySection(context);
    case 'sandbox':
      return sandboxPolicySection(context);
  }
}

export { chromePolicySection } from './chrome-policy';
export { headlessPolicySection } from './headless-policy';
export { iosPolicySection } from './ios-policy';
export { sandboxPolicySection } from './sandbox-policy';
export { tuiPolicySection } from './tui-policy';
