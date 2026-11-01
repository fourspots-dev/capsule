# ADR-016: Enforce UI consistency with contracts, components and executable gates

- Status: accepted
- Date: 2026-11-01
- Approved by: user
- Requirements: REQ-UI-001
- Origin decision: DEC-010
- Supersedes: none
- Superseded by: none

## Context

New Side Panel settings controls repeatedly introduced local visual systems:
native borders, independent cards, inconsistent form spacing and different
subpage navigation. A prose preference in chat does not survive context
compaction, and the user explicitly rejected adding project-specific UI rules to
`AGENTS.md`.

## Decision

UI consistency is enforced through four collaborating artifacts:

1. A versioned Side Panel UI Contract documents visual tokens, component
   anatomy, navigation, responsive requirements and evidence.
2. `src/sidepanel/settings-components.ts` owns canonical Settings markup
   primitives and is the default implementation for every settings page.
3. Deterministic static/unit checks and real Chrome E2E tests reject raw settings
   primitives, missing navigation and computed-style drift.
4. Requirement, design and architecture templates require a UI impact map when a
   change touches a client surface.

`AGENTS.md` contains no requirement-specific UI rules. The component API and
executable checks are the durable enforcement mechanism.

## Invariants

- Settings pages compose `settingsSubpage`, `settingsGroup`, `settingsCard`,
  `settingsRow`, `settingsNavRow`, `settingsSelectRow` or `settingsForm`.
- `kernel-panel.ts` does not emit raw `wb-set-card`, `wb-set-group` or
  `wb-set-row` markup for settings pages.
- Clickable settings rows have no native button border or background.
- All settings text fields share the same label, focus, border and radius in the
  Connections and Remote Actions forms.
- Settings subpages return to Settings before closing to the conversation.
- UI changes have responsive and computed-style evidence.

## Alternatives considered

- Add a detailed UI section to `AGENTS.md`. Rejected by the user and prone to
  becoming stale, duplicated guidance.
- Rely only on screenshot review. Rejected because screenshots are not stable
  enough as the sole gate and do not document component composition.
- Keep string templates in `kernel-panel.ts` with code comments. Rejected
  because the convenient path would still be to create new local primitives.

## Consequences

The Side Panel gains an explicit component layer and an additional static check.
Some existing markup must be migrated rather than incrementally patched.
Screenshot review remains necessary for visual judgment, but structural and
computed-style failures become deterministic.

## Affected surfaces

- Side Panel Settings, Connections, History, Capabilities and Remote Actions
- Side Panel CSS tokens and shared form/row classes
- Requirement, design, testing and architecture templates
- Deterministic unit/static checks and Chrome E2E
- No runtime, host, Session, Capsule or Tool contracts

## Verification

- `npm run check:ui`
- `tests/sidepanel/settings-components.test.ts`
- `tests/e2e/sidepanel-ui-contract.e2e.ts`
- Existing `tests/e2e/kernel-extension.e2e.ts`
- Manual review at 420x900 and 320x700
