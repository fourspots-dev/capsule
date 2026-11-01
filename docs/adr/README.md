# Architecture Decision Records

ADR 保存长期有效的架构决策和原因。REQ 描述要交付的工作，ADR 说明为什么系
统必须保持某种边界、协议或行为。

## 何时创建 ADR

- 引入或改变模块边界和依赖方向。
- 定义公共协议、持久化格式、信任模型或跨端契约。
- 在长期架构方案之间做选择。
- 决策影响多个需求或多个执行面。
- 替代已经 Accepted 的架构决定。

普通功能实现、局部 bug 和小范围重构通常只需要 REQ，不需要 ADR。

## 文件与注册

文件：

```text
docs/adr/ADR-NNN-kebab-title.md
```

注册表：

```text
policy/adr-registry.json
```

ADR ID 创建后不可复用。文件名、正文标题和注册表 ID 必须一致。

## 状态

```text
proposed
  ├─ accepted
  └─ rejected

accepted
  ├─ superseded
  └─ deprecated

rejected / superseded / deprecated
  └─ terminal
```

- `proposed`：方案正在讨论。
- `accepted`：用户确认，作为当前架构约束。
- `rejected`：方案被拒绝，作为历史备选保留。
- `superseded`：新 ADR 取代；必须记录 `Superseded by`。
- `deprecated`：仍保留历史，但不再作为新设计依据。

Accepted ADR 不得删除或静默改写。决策变化必须创建新 ADR，并在新旧 ADR
之间建立对称引用。仅允许不改变语义的排版、链接或错字修订，且提交必须说明
这是 editorial change；Decision、Invariants、边界或验收含义变化必须新建 ADR。
Rejected、Superseded 和 Deprecated 是历史终态，不得改回当前架构约束。

## 审批

状态从 `proposed` 变为 `accepted` 或 `rejected` 需要用户确认。ADR 的接受
不授权实现；实现仍受 REQ 的详细设计确认和 `implementationAuthorized`
门禁限制。

## 与 REQ 的关系

- REQ 可以在详细设计中引用一个或多个 Accepted ADR。
- 每个 ADR 必须至少有一个来源：受影响 REQ 或 `Origin decision: DEC-NNN`。
- 讨论中先形成的规则可以暂时没有 REQ，但不能没有 DEC 来源。
- ADR registry 保存机器可读关联，ADR 正文的 Requirements 必须与其一致。
- ADR 回答为什么保持规则，REQ 回答要交付什么，详细设计回答怎样实现，
  详细测试设计回答怎样证明。
- 若 ADR 与 REQ 设计冲突，以新的 Accepted ADR 和新的 REQ 变更为准。
- Rejected/Superseded ADR 只能作为历史背景，不能作为当前实现依据。

## 校验

```sh
npm run adr:check
```

校验包括 ID、文件、状态、必需章节、用户批准、受影响 REQ、Supersede 对
称关系、循环引用、孤立 ADR 文件、正文/registry 元数据一致性和 registry
结构。

## 创建流程

1. Agent 在 decision sweep 中判断这是长期架构决定。
2. 先创建或引用 `DEC-NNN`，保留原始决定来源。
3. 预留新的 `ADR-NNN` ID。
4. 从 `template.md` 创建文件。
5. 写 Context、Decision、Invariants、Alternatives、Consequences、Affected
   surfaces 和 Verification。
6. 在 `policy/adr-registry.json` 注册，状态设为 `proposed`，写入
   `originDecision`。
7. 主动向用户提交确认包；用户确认后设为 `accepted` 或 `rejected`，记录批准
   来源和日期。
8. 运行 `npm run decisions:check`、`npm run adr:check` 和
   `npm run requirements:check`。

## 改变已有决策

1. 不修改旧 ADR 的 Decision 或 Invariants。
2. 新建下一个 `ADR-NNN`，在 `Supersedes` 写出旧 ADR。
3. 将旧 ADR 标为 `superseded`，在 `Superseded by` 写出新 ADR。
4. 新 ADR 经用户确认后设为 `accepted`。
5. 更新受影响 REQ 的详细设计引用。
6. 运行 `npm run adr:check` 和 `npm run requirements:check`。

## 评审检查单

- 决策解决的是长期、跨需求问题，而不是普通局部实现。
- Context 描述了约束和失败代价，Decision 是可执行规则。
- Invariants 足够具体，未来代码和测试可以检查。
- 至少记录一个认真考虑过的替代方案和未采用原因。
- Consequences 同时包含收益、代价、迁移和维护责任。
- Affected surfaces 覆盖 Provider、Consumer、持久化、客户端和验证。
- Verification 明确了长期保持该决策的自动化检查或运行证据。
- 与既有 ADR 的冲突已通过新的 Supersede 关系处理。
