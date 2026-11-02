# ADR-019: Chrome for Testing is the canonical E2E browser

- Status: accepted
- Date: 2026-11-02
- Approved by: user
- Requirements: REQ-ENG-009
- Origin decision: DEC-013
- Supersedes: none
- Superseded by: none

## Context

All Chrome E2E files previously duplicated executable discovery and preferred
Chrome for Testing only by convention. Missing CfT silently fell back to Stable
Chrome, making results less reproducible and obscuring which browser profile ran.

## Decision

Create one shared E2E launcher. The default gate strictly uses Chrome for Testing
headless. A headed CfT mode supports visible browser validation. Stable Chrome
has its own explicit command and never replaces CfT in the default profile.

## Invariants

- `npm run test:e2e` resolves CfT only.
- Missing CfT fails with installation guidance.
- `npm run test:e2e:headed` uses the same CfT baseline with a visible UI.
- `npm run test:e2e:stable` is opt-in release smoke.
- Every E2E file uses the shared launcher and the same extension flags.
- Explicit `TINYAI_CHROME_EXECUTABLE` may override for diagnosis without changing
  the default policy.

## Alternatives considered

- Continue preferring CfT with silent Stable fallback. Rejected because test
  evidence becomes ambiguous.
- Use Stable Chrome for every E2E. Rejected because unpacked-extension automation
  and version reproducibility are weaker.
- Use headless mode only. Rejected because browser UI and focus behavior still
  need visible validation.

## Consequences

Developers must install Playwright Chromium/CfT or configure an explicit path.
CI is more reproducible. Stable Chrome release smoke remains available but is not
part of the default pass/fail baseline.

## Affected surfaces

- Chrome E2E launcher and all E2E spec files
- package test commands and test documentation
- Chrome release smoke procedure
- No Agent Runtime or production behavior

## Verification

- Shared CfT resolution test path
- `npm run test:e2e` headless suite
- Headed CfT focused smoke
- Explicit Stable profile resolution
