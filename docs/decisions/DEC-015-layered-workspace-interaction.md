# DEC-015: Layered workspace resource paths and host interactions

- Status: promoted
- Captured: 2026-11-02
- Source: discussion
- Scope: workspace, paths, host-ports, chrome, tui, ios, verification, prompt
- Triage: adr_and_requirement
- ADRs: ADR-021
- Requirements: REQ-WORKSPACE-003, REQ-HOST-004, REQ-CHROME-002, REQ-VERIFY-002
- Supersedes: none
- Superseded by: none

## Statement

虚拟文件不能继续沿用全局固定 VFS，也不能把 `file://`、Chrome 预览标签或下载能力写成
Agent 通用路径语义。不同宿主都需要打开、导出和验证 Workspace 资源，但具体交互方式必须
由宿主能力决定。

## Normalized decision

Separate Workspace scope, canonical resource identity and relative paths from
host-specific workspace open/export adapters and host-aware verification
evidence. Expose agent tools only for capabilities discovered from the active
host. Bind Chrome files to label-group or standalone-tab Workspace scopes rather
than one extension-global filesystem.

## Rationale

The current Chrome runtime uses one storage-backed VFS for every tab while the
UI and Session model exposes group and standalone scopes. Agents also have no
explicit canonical resource identity, so they attempt host paths or temporary
page injection. This causes workspace leakage, false “double-click” claims and
incorrect task failure after otherwise successful browser validation.

## Promotion

- ADR-021 proposes the layering and ownership rules.
- Four requirements cover scope/path, host ports, Chrome adaptation and
  verification evidence.
- Implementation remains blocked until the ADR and requirement designs are
  reviewed and explicitly authorized.
