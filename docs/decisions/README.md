# Decision Inbox

Decision Inbox 保存讨论中形成的长期决定。它先于 REQ 和 ADR 存在，解决“某
个决定不是从具体需求开始”的留痕问题。

```text
讨论
  └─ DEC-NNN
       ├─ 局部实现细节 → 附到 REQ 设计
       ├─ 可执行工作     → REQ
       ├─ 长期架构规则   → ADR
       ├─ ADR + 未来 REQ → 先记录规则，之后再落地
       └─ 不采用         → no_action / withdrawn
```

## Agent 何时捕获

Agent 必须自己完成 decision sweep，不能等用户要求写 ADR。出现以下表达或语义
时，应创建 DEC：

- 用户对长期默认值、边界、协议、优先级或禁止行为作出选择；
- 用户接受或拒绝一个长期架构替代方案；
- 讨论决定会影响多个后续需求或执行面；
- 实现过程中出现必须接受的长期例外或 workaround。

临时猜测、未确认选项和局部措辞不创建 DEC。仓库只记录决定、范围和理由，不
复制完整对话、Secret 或无关个人信息。

## 捕获后的检查点

Agent 在以下时点重新 triage：

1. 新 REQ 创建或接受时。
2. 详细设计具体化后、进入 review 前。
3. 实现中发现新的边界或协议变化时。
4. 发布前检查失效、替代和未处理决定；每次 `A.B` 版本做一次完整 ADR 组合审查。

没有长期影响时记录 `no_action`；能归入现有设计时记录 `design_detail`；需要
长期架构规则时创建 `ADR-NNN / proposed`，然后向用户展示一次评审包并停止依赖
该决定的实现工作。

## 文件与注册

```text
docs/decisions/DEC-NNN-kebab-title.md
policy/decision-registry.json
```

DEC ID 永久且不复用。正文标题、状态、来源、triage 目标和 registry 必须一致。

## 状态

```text
captured
  ├─ needs_clarification
  ├─ triaged
  │    └─ promoted
  ├─ no_action
  ├─ withdrawn
  └─ superseded
```

`promoted` 表示至少一个 ADR 或 REQ 已由该决定产生。DEC 本身不授予实现权限。
被新决定取代时，新 DEC 记录 `Supersedes`，旧 DEC 记录 `Superseded by`。

## Triage

合法 disposition：

```text
adr | requirement | adr_and_requirement | design_detail | no_action
```

`adr` 和 `adr_and_requirement` 必须指向真实 ADR，且 ADR 的
`Origin decision` 回指该 DEC。`requirement` 和 `adr_and_requirement` 必须指向
真实 REQ。

## 与 ADR 的关系

- ADR 可以关联 REQ，也可以只由 DEC 提供来源。
- `Requirements: none` 只在此 ADR 有 `Origin decision: DEC-NNN` 时合法。
- 用户确认 Proposed ADR 后才可变 Accepted；确认仍不等于实现授权。
- 修改旧 ADR 的 Decision 或 Invariants 时新建 ADR 并建立 Supersede 链。

## 校验

```sh
npm run decisions:check
```

校验 ID、文档、状态、时间、来源、scope、triage、ADR/REQ 双向关联、Supersede、
孤立文件以及正文与 registry 的一致性。
