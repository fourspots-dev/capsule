import { AgentError } from './errors';
import type { JsonValue } from './types';

export type SessionEntryType =
  | 'message'
  | 'model_change'
  | 'compaction'
  | 'branch_summary'
  | 'context_edit'
  | 'custom';

export type SessionMessageRole = 'user' | 'assistant' | 'tool' | 'bash' | 'system';

export interface SessionMessagePayload {
  role: SessionMessageRole;
  content: JsonValue;
  toolCallId?: string;
  toolName?: string;
  toolCallIds?: string[];
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface ContextEditPayload {
  hideEntryIds?: string[];
  replacements?: Record<string, JsonValue>;
}

export interface CompactionPayload {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  details?: {
    readFiles?: string[];
    modifiedFiles?: string[];
    approvedPlanPath?: string;
  };
}

export interface SessionEntry {
  id: string;
  parentId: string | null;
  type: SessionEntryType;
  createdAt: number;
  payload: JsonValue;
}

export interface AppendEntryInput {
  type: SessionEntryType;
  payload: JsonValue;
  id?: string;
  parentId?: string | null;
  createdAt?: number;
}

export interface SessionContextItem {
  sourceEntryId: string;
  role: SessionMessageRole | 'compaction';
  content: JsonValue;
}

export interface SessionContext {
  leafId: string | null;
  items: SessionContextItem[];
  effectivePath: SessionEntry[];
  latestCompactionEntryId?: string;
  readFiles: string[];
  modifiedFiles: string[];
  approvedPlanPath?: string;
}

export class SessionTree {
  private readonly entries = new Map<string, SessionEntry>();
  private activeLeafId: string | null;
  private sequence = 0;

  constructor(
    options: {
      entries?: SessionEntry[];
      activeLeafId?: string | null;
      now?: () => number;
    } = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    for (const entry of options.entries ?? []) this.loadEntry(entry);
    this.activeLeafId = options.activeLeafId ?? null;
    if (this.activeLeafId && !this.entries.has(this.activeLeafId)) {
      throw new AgentError(
        'SESSION_LEAF_NOT_FOUND',
        `Active leaf not found: ${this.activeLeafId}`
      );
    }
  }

  private readonly now: () => number;

  get activeLeaf(): string | null {
    return this.activeLeafId;
  }

  append(input: AppendEntryInput): SessionEntry {
    const parentId =
      input.parentId === undefined ? this.activeLeafId : input.parentId;
    if (parentId !== null && !this.entries.has(parentId)) {
      throw new AgentError('SESSION_PARENT_NOT_FOUND', `Parent entry not found: ${parentId}`);
    }
    const id = input.id ?? `entry_${++this.sequence}`;
    if (this.entries.has(id)) {
      throw new AgentError('SESSION_ENTRY_DUPLICATE', `Session entry already exists: ${id}`);
    }
    const match = id.match(/^entry_(\d+)$/);
    if (match) this.sequence = Math.max(this.sequence, Number(match[1]));
    const entry: SessionEntry = {
      id,
      parentId,
      type: input.type,
      createdAt: input.createdAt ?? this.now(),
      payload: cloneJson(input.payload),
    };
    this.entries.set(id, entry);
    this.activeLeafId = id;
    return cloneEntry(entry);
  }

  get(id: string): SessionEntry | undefined {
    const entry = this.entries.get(id);
    return entry ? cloneEntry(entry) : undefined;
  }

  selectLeaf(id: string): void {
    if (!this.entries.has(id)) {
      throw new AgentError('SESSION_LEAF_NOT_FOUND', `Session entry not found: ${id}`);
    }
    this.activeLeafId = id;
  }

  branch(entryId: string): SessionEntry[] {
    this.selectLeaf(entryId);
    return this.activePath();
  }

  activePath(): SessionEntry[] {
    if (!this.activeLeafId) return [];
    const path: SessionEntry[] = [];
    const seen = new Set<string>();
    let currentId: string | null = this.activeLeafId;
    while (currentId) {
      if (seen.has(currentId)) {
        throw new AgentError('SESSION_TREE_CYCLE', `Cycle detected at session entry ${currentId}`);
      }
      seen.add(currentId);
      const entry = this.entries.get(currentId);
      if (!entry) {
        throw new AgentError(
          'SESSION_PARENT_NOT_FOUND',
          `Missing parent while resolving path: ${currentId}`
        );
      }
      path.push(entry);
      currentId = entry.parentId;
    }
    return path.reverse().map(cloneEntry);
  }

  context(leafId = this.activeLeafId): SessionContext {
    const path = this.pathTo(leafId);
    const hidden = new Set<string>();
    const replacements = new Map<string, JsonValue>();
    for (const entry of path) {
      if (entry.type !== 'context_edit') continue;
      const edit = entry.payload as unknown as ContextEditPayload;
      for (const id of edit.hideEntryIds ?? []) hidden.add(id);
      for (const [id, value] of Object.entries(edit.replacements ?? {})) {
        replacements.set(id, cloneJson(value));
      }
    }

    const latestCompactionIndex = findLastIndex(path, (entry) => entry.type === 'compaction');
    const latestCompaction =
      latestCompactionIndex >= 0 ? path[latestCompactionIndex] : undefined;
    let rangeStart = 0;
    const items: SessionContextItem[] = [];
    if (latestCompaction) {
      const compaction = latestCompaction.payload as unknown as CompactionPayload;
      const keptIndex = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
      if (keptIndex < 0 || keptIndex >= latestCompactionIndex) {
        throw new AgentError(
          'COMPACTION_BOUNDARY_INVALID',
          `Compaction ${latestCompaction.id} references an invalid retained entry`
        );
      }
      items.push({
        sourceEntryId: latestCompaction.id,
        role: 'compaction',
        content: compaction.summary,
      });
      rangeStart = keptIndex;
    }

    const effectivePath: SessionEntry[] = [];
    for (let index = rangeStart; index < path.length; index += 1) {
      const entry = path[index];
      if (entry.type === 'compaction' || entry.type === 'context_edit' || entry.type === 'model_change') {
        continue;
      }
      if (hidden.has(entry.id)) continue;
      if (entry.type === 'message') {
        const message = entry.payload as unknown as SessionMessagePayload;
        items.push({
          sourceEntryId: entry.id,
          role: message.role,
          content: cloneJson(replacements.get(entry.id) ?? message.content),
        });
        effectivePath.push(entry);
      } else if (entry.type === 'custom') {
        items.push({
          sourceEntryId: entry.id,
          role: 'user',
          content: cloneJson(replacements.get(entry.id) ?? entry.payload),
        });
        effectivePath.push(entry);
      } else if (entry.type === 'branch_summary') {
        effectivePath.push(entry);
      }
    }

    const details = latestCompaction
      ? (latestCompaction.payload as unknown as CompactionPayload).details
      : undefined;
    return {
      leafId: leafId,
      items,
      effectivePath,
      ...(latestCompaction ? { latestCompactionEntryId: latestCompaction.id } : {}),
      readFiles: [...(details?.readFiles ?? [])],
      modifiedFiles: [...(details?.modifiedFiles ?? [])],
      ...(details?.approvedPlanPath
        ? { approvedPlanPath: details.approvedPlanPath }
        : {}),
    };
  }

  fork(entryId = this.activeLeafId): SessionTree {
    if (entryId !== null && !this.entries.has(entryId)) {
      throw new AgentError('SESSION_LEAF_NOT_FOUND', `Session entry not found: ${entryId}`);
    }
    return new SessionTree({
      entries: [...this.entries.values()].map(cloneEntry),
      activeLeafId: entryId,
      now: this.now,
    });
  }

  children(parentId: string | null): SessionEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.parentId === parentId)
      .map(cloneEntry);
  }

  rawEntries(): SessionEntry[] {
    return [...this.entries.values()].map(cloneEntry);
  }

  private pathTo(leafId: string | null): SessionEntry[] {
    if (!leafId) return [];
    const previous = this.activeLeafId;
    this.activeLeafId = leafId;
    try {
      return this.activePath();
    } finally {
      this.activeLeafId = previous;
    }
  }

  private loadEntry(input: SessionEntry): void {
    if (this.entries.has(input.id)) {
      throw new AgentError('SESSION_ENTRY_DUPLICATE', `Session entry already exists: ${input.id}`);
    }
    this.entries.set(input.id, cloneEntry(input));
    const match = input.id.match(/^entry_(\d+)$/);
    if (match) this.sequence = Math.max(this.sequence, Number(match[1]));
  }
}

export function appendMessage(
  tree: SessionTree,
  message: SessionMessagePayload,
  options: Pick<AppendEntryInput, 'id' | 'parentId' | 'createdAt'> = {}
): SessionEntry {
  return tree.append({
    ...options,
    type: 'message',
    payload: message as unknown as JsonValue,
  });
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function cloneEntry(entry: SessionEntry): SessionEntry {
  return { ...entry, payload: cloneJson(entry.payload) };
}

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJson(child)])
    );
  }
  return value;
}
