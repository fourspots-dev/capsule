# ADR-007: Generic profiles for subagents

- Status: accepted
- Date: 2026-11-01
- Approved by: user
- Requirements: REQ-SUBAGENT-001
- Supersedes: none
- Superseded by: none

## Context

Fixed Researcher/Reviewer roles are too narrow for arbitrary coding tasks and
cause duplicate agent implementations.

## Decision

Subagents are instances of configurable Agent Profiles. Profiles define
instructions, tools, permissions, context mode, execution mode, depth and
concurrency.

## Invariants

- Child capabilities are a subset of parent policy.
- Child Workspace and Action binding are explicit.
- Parent cancellation propagates.
- Results and evidence identify the child Session/Task.

## Alternatives considered

- Hard-coded role classes.
- Unrestricted child agents sharing the parent workspace.

## Consequences

The coordinator remains generic, while applications can define domain profiles
without changing Core.

## Affected surfaces

Agent Profiles, Subagent Coordinator, Workspace forks, Action Context, TUI Agent
Board and Capsule.

## Verification

Profile, isolation, merge, cancellation, budget and evidence tests.
