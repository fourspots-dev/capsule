import type { VirtualFileSystem } from '../virtual';
import {
  agentProfileSection,
  projectInstructionsSection,
  runtimeContextSection,
  selectedSkillSection,
  skillContextSection,
} from './agent-context';
import { hostPolicySection } from './adapters';
import { corePolicySection } from './core-policy';
import { executionPolicySection, permittedTools } from './execution-policy';
import { modePolicySection } from './mode-policy';
import type {
  PromptBuildContext,
  PromptEnvelope,
  PromptLayer,
  PromptSection,
  RenderedPromptSection,
} from './prompt-context';
import { workspacePolicySection } from './workspace-policy';

const LAYER_ORDER: Record<PromptLayer, number> = {
  core: 0,
  workspace: 1,
  host: 2,
  execution: 3,
  mode: 4,
  profile: 5,
  project: 6,
  capabilities: 7,
  skill: 8,
  runtime: 9,
};

const DEFAULT_MAX_CHARACTERS = 32_000;
const TRUNCATION_MARKER = '\n[section truncated by prompt budget]';

export class PromptCompositionError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'PromptCompositionError';
  }
}

export class PromptAssembler {
  private readonly sections: readonly PromptSection[];
  private readonly maxCharacters: number;

  constructor(options: {
    sections?: readonly PromptSection[];
    maxCharacters?: number;
  } = {}) {
    this.sections = options.sections ?? [];
    this.maxCharacters =
      options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  }

  build(context: PromptBuildContext): PromptEnvelope {
    const sections = this.collect(context);
    this.assertUnique(sections);
    const ordered = [...sections].sort(
      (left, right) =>
        LAYER_ORDER[left.layer] - LAYER_ORDER[right.layer] ||
        right.priority - left.priority ||
        left.id.localeCompare(right.id)
    );
    const rendered = ordered.map((section) => {
      const text = section.render(context).trim();
      return {
        section,
        text,
        truncated: false,
      };
    });
    const requiredCharacters = rendered
      .filter((entry) => entry.section.required)
      .reduce((total, entry) => total + entry.text.length, 0);
    if (requiredCharacters > this.maxCharacters) {
      throw new PromptCompositionError(
        'PROMPT_BUDGET_TOO_SMALL',
        `Required prompt sections need ${requiredCharacters} characters but the budget is ${this.maxCharacters}`
      );
    }

    let remaining =
      this.maxCharacters - requiredCharacters;
    const omittedSections: string[] = [];
    const optional = rendered
      .filter((entry) => !entry.section.required && entry.text.length > 0)
      .sort(
        (left, right) =>
          right.section.priority - left.section.priority ||
          LAYER_ORDER[left.section.layer] - LAYER_ORDER[right.section.layer]
      );
    for (const entry of optional) {
      if (entry.text.length <= remaining) {
        remaining -= entry.text.length;
        continue;
      }
      const available = remaining - TRUNCATION_MARKER.length;
      if (available > 0) {
        entry.text = `${entry.text.slice(0, available).trimEnd()}${TRUNCATION_MARKER}`;
        entry.truncated = true;
        remaining = 0;
      } else {
        entry.text = '';
        omittedSections.push(entry.section.id);
      }
    }

    const included = rendered.filter((entry) => entry.text.length > 0);
    const grouped = {
      stable: included.filter((entry) => entry.section.cache === 'stable'),
      session: included.filter((entry) => entry.section.cache === 'session'),
      request: included.filter((entry) => entry.section.cache === 'request'),
    };
    const stablePrefix = joinSections(grouped.stable);
    const sessionContext = joinSections(grouped.session);
    const requestContext = joinSections(grouped.request);
    const fullPrompt = [stablePrefix, sessionContext, requestContext]
      .filter(Boolean)
      .join('\n\n');
    const capabilityFingerprint = fingerprintCapabilities(context);
    const manifestSections: RenderedPromptSection[] = included.map(
      ({ section, text, truncated }) => ({
        id: section.id,
        layer: section.layer,
        kind: section.kind,
        priority: section.priority,
        trust: section.trust,
        cache: section.cache,
        characters: text.length,
        estimatedTokens: estimateTokens(text),
        truncated,
      })
    );
    const cacheKey = stableHash(
      [
        'prompt-v1',
        context.hostProfile,
        context.workspaceProfile,
        context.mode,
        capabilityFingerprint,
        ...manifestSections.map(
          (section, index) =>
            `${section.id}:${included[index]?.text ?? ''}`
        ),
      ].join('|')
    );
    return {
      stablePrefix,
      sessionContext,
      requestContext,
      fullPrompt,
      manifest: {
        version: 1,
        hostProfile: context.hostProfile,
        workspaceProfile: context.workspaceProfile,
        mode: context.mode,
        capabilityFingerprint,
        cacheKey,
        totalCharacters: fullPrompt.length,
        estimatedTokens: estimateTokens(fullPrompt),
        sections: manifestSections,
        omittedSections,
      },
    };
  }

  private collect(context: PromptBuildContext): PromptSection[] {
    const configured = this.sections.length
      ? this.sections.map((section) => section)
      : [
          corePolicySection,
          workspacePolicySection(context),
          hostPolicySection(context),
          executionPolicySection(context),
          modePolicySection(context),
        ];
    return [
      ...configured,
      ...[
        agentProfileSection(context),
        projectInstructionsSection(context),
        skillContextSection(context),
        selectedSkillSection(context),
        runtimeContextSection(context),
      ].filter((section): section is PromptSection => Boolean(section)),
    ];
  }

  private assertUnique(sections: readonly PromptSection[]): void {
    const seen = new Set<string>();
    for (const section of sections) {
      if (seen.has(section.id)) {
        throw new PromptCompositionError(
          'PROMPT_SECTION_DUPLICATE',
          `Prompt section appears more than once: ${section.id}`
        );
      }
      seen.add(section.id);
    }
  }
}

export async function loadProjectInstructions(
  fs: Pick<VirtualFileSystem, 'read' | 'stat'>,
  maxCharacters = 8000
): Promise<string | undefined> {
  try {
    const info = await fs.stat('AGENTS.md');
    if (!info || info.kind !== 'file') return undefined;
    const bytes = await fs.read('AGENTS.md');
    return new TextDecoder()
      .decode(bytes)
      .trim()
      .slice(0, maxCharacters);
  } catch {
    return undefined;
  }
}

export function buildPrompt(context: PromptBuildContext): PromptEnvelope {
  return new PromptAssembler({
    ...(context.budget ? { maxCharacters: context.budget.maxCharacters } : {}),
  }).build(context);
}

function joinSections(
  entries: ReadonlyArray<{ text: string }>
): string {
  return entries.map((entry) => entry.text).join('\n\n');
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function fingerprintCapabilities(context: PromptBuildContext): string {
  const tools = permittedTools(context)
    .map((tool) => `${tool.name}:${tool.description}`)
    .sort();
  const actions = (context.actions ?? [])
    .map((action) => action.descriptor.id)
    .sort();
  const intelligence = context.codeIntelligence
    ? [
        context.codeIntelligence.provider,
        ...Object.entries(context.codeIntelligence)
          .filter(([key, value]) => key !== 'provider' && typeof value === 'boolean')
          .map(([key, value]) => `${key}:${String(value)}`),
      ]
    : [];
  return stableHash(JSON.stringify([tools, actions, intelligence]));
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
