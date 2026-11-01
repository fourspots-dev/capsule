# Architecture Change Contract

Use this checklist for any requirement with `architectureImpact: true`.

Detailed design approval and explicit user authorization are mandatory before
product code changes. `accepted` alone is not an implementation gate.

## 1. Map Before Code

List every provider and consumer:

- Core, Host, Adapter, and composition root
- Headless, TUI, CLI, Chrome, Sandbox, and future clients
- Prompt, ToolRegistry, UI, diagnostics, and verification
- Session, Artifact, Jobs, Capsule, and persistence
- discovery, invocation, cancellation, failure, recovery, and disposal
- legacy path removal, compatibility fallback, and version migration

Every item must be marked `modify` with an evidence target or `none` with a
technical reason.

## 2. Required Invariants

State the properties that must remain true. Typical examples:

- one shared ToolPack implementation;
- one normalized Tool Schema per capability;
- Prompt, Registry, and UI expose the same enabled capabilities;
- no implicit fallback to a legacy capability;
- completion requires current host evidence;
- unavailable capabilities remain visible as unavailable.

## 3. Forbidden Partial Delivery

List forbidden shortcuts, such as duplicating logic in TUI, silently retaining
`exec`, hard-coding capability lists, or declaring completion from historical
evidence.

## 4. End-to-End Evidence

Provide:

- contract and schema golden tests;
- provider success, unavailable, denied, and fault tests;
- one user journey for every required client/profile;
- persistence, import/export, session resume, and version migration tests;
- explicit evidence for legacy cleanup.

## 5. Completion Audit

Re-open the impact map after implementation. A requirement is not complete
while any required consumer has no implementation or evidence.
