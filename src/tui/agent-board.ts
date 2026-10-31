import type { AgentFilter, AgentTreeRow, TuiAgentRecord } from './types';

interface MutableNode {
  agent: TuiAgentRecord;
  children: MutableNode[];
}

export function buildAgentRows(
  records: readonly TuiAgentRecord[],
  rootSessionId: string,
  filter: AgentFilter = 'all'
): AgentTreeRow[] {
  const nodes = new Map<string, MutableNode>();
  for (const agent of records) nodes.set(agent.taskId, { agent, children: [] });
  const roots: MutableNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.agent.parentTaskId);
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const sortNodes = (items: MutableNode[]): void => {
    items.sort(
      (left, right) =>
        (left.agent.createdAt ?? 0) - (right.agent.createdAt ?? 0) ||
        left.agent.taskId.localeCompare(right.agent.taskId)
    );
    for (const item of items) sortNodes(item.children);
  };
  sortNodes(roots);
  const rows: AgentTreeRow[] = [];
  const visit = (node: MutableNode, depth: number, ancestorMatched: boolean): boolean => {
    const matched = ancestorMatched || matches(node.agent, filter);
    const before = rows.length;
    if (matched) {
      rows.push({
        agent: node.agent,
        depth,
        hasChildren: node.children.length > 0,
      });
    }
    let childMatched = false;
    for (const child of node.children) {
      childMatched = visit(child, depth + 1, matched) || childMatched;
    }
    if (!matched && childMatched) {
      rows.splice(before, 0, {
        agent: node.agent,
        depth,
        hasChildren: true,
      });
    }
    return matched || childMatched;
  };
  for (const root of roots) visit(root, 0, false);
  return rows.filter((row) => row.agent.parentSessionId === undefined || row.agent.parentSessionId === rootSessionId || filter === 'all');
}

export function selectAgent(
  rows: readonly AgentTreeRow[],
  selectedId: string | undefined,
  direction: -1 | 1
): string | undefined {
  if (!rows.length) return undefined;
  const index = selectedId
    ? rows.findIndex((row) => row.agent.taskId === selectedId)
    : -1;
  const next = index < 0
    ? direction > 0
      ? 0
      : rows.length - 1
    : (index + direction + rows.length) % rows.length;
  return rows[next].agent.taskId;
}

function matches(agent: TuiAgentRecord, filter: AgentFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return agent.status === 'running' || agent.status === 'queued';
  if (filter === 'attention') {
    return agent.status === 'failed' || agent.status === 'cancelled' || agent.attention === true;
  }
  return agent.status === 'completed';
}
