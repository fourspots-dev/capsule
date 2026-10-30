import { AgentError } from './errors';
import {
  appendMessage,
  type CompactionPayload,
  type SessionEntry,
  type SessionMessagePayload,
  type SessionTree,
} from './session-tree';
import type { JsonValue } from './types';

export interface ContextBudget {
  contextWindow: number;
  reserveTokens: number;
  keepRecentTokens: number;
  maxOutputTokens: number;
}

export interface CompactionPlan {
  firstKeptEntryId: string;
  tokensBefore: number;
  tokensAfter: number;
  retainedEntryIds: string[];
}

export interface CompactionRequest {
  summary: string;
  budget: ContextBudget;
  usage?: CompactionPayload['usage'];
  details?: CompactionPayload['details'];
  estimateTokens?: TokenEstimator;
}

export interface CompactionResult {
  entry: SessionEntry;
  plan: CompactionPlan;
}

export type TokenEstimator = (entry: SessionEntry) => number;

export function defaultTokenEstimator(entry: SessionEntry): number {
  return Math.max(1, Math.ceil(JSON.stringify(entry.payload).length / 4));
}

export function needsCompaction(
  tree: SessionTree,
  budget: ContextBudget,
  estimateTokens: TokenEstimator = defaultTokenEstimator
): boolean {
  validateBudget(budget);
  const path = tree.activePath();
  return totalTokens(path, estimateTokens) > budget.contextWindow - budget.reserveTokens;
}

export function planCompaction(
  tree: SessionTree,
  budget: ContextBudget,
  estimateTokens: TokenEstimator = defaultTokenEstimator
): CompactionPlan {
  validateBudget(budget);
  const path = tree.activePath();
  if (path.length < 2) {
    throw new AgentError(
      'COMPACTION_CUTPOINT_UNAVAILABLE',
      'At least two session entries are required for compaction'
    );
  }
  const latestCompactionIndex = lastCompactionIndex(path);
  const candidates: Array<{ index: number; tailTokens: number }> = [];
  let tailTokens = 0;
  for (let index = path.length - 1; index >= latestCompactionIndex + 1; index -= 1) {
    const entry = path[index];
    if (entry.type !== 'compaction' && entry.type !== 'context_edit' && entry.type !== 'model_change') {
      tailTokens += estimateTokens(entry);
    }
    if (isSafeCutpoint(entry) && tailTokens >= budget.keepRecentTokens) {
      candidates.push({ index, tailTokens });
    }
  }
  if (candidates.length === 0) {
    throw new AgentError(
      'COMPACTION_CUTPOINT_UNAVAILABLE',
      'No user/assistant/custom/bash boundary preserves the requested recent context'
    );
  }
  const candidate = candidates[0];
  const retained = path.slice(candidate.index);
  return {
    firstKeptEntryId: path[candidate.index].id,
    tokensBefore: totalTokens(path, estimateTokens),
    tokensAfter: candidate.tailTokens,
    retainedEntryIds: retained.map((entry) => entry.id),
  };
}

export function appendCompaction(
  tree: SessionTree,
  request: CompactionRequest
): CompactionResult {
  if (!request.summary.trim()) {
    throw new AgentError('COMPACTION_SUMMARY_EMPTY', 'Compaction summary cannot be empty');
  }
  const estimateTokens = request.estimateTokens ?? defaultTokenEstimator;
  const plan = planCompaction(tree, request.budget, estimateTokens);
  const payload: CompactionPayload = {
    summary: request.summary.trim(),
    firstKeptEntryId: plan.firstKeptEntryId,
    tokensBefore: plan.tokensBefore,
    ...(request.usage ? { usage: { ...request.usage } } : {}),
    ...(request.details
      ? {
          details: {
            readFiles: [...(request.details.readFiles ?? [])],
            modifiedFiles: [...(request.details.modifiedFiles ?? [])],
            ...(request.details.approvedPlanPath
              ? { approvedPlanPath: request.details.approvedPlanPath }
              : {}),
          },
        }
      : {}),
  };
  const parentId = tree.activeLeaf;
  const entry = tree.append({
    type: 'compaction',
    parentId,
    payload: payload as unknown as JsonValue,
  });
  return { entry, plan };
}

export function compactionContext(entry: SessionEntry): CompactionPayload {
  if (entry.type !== 'compaction') {
    throw new AgentError('COMPACTION_ENTRY_INVALID', `Entry is not a compaction: ${entry.id}`);
  }
  const payload = entry.payload as unknown as CompactionPayload;
  if (!payload.summary || !payload.firstKeptEntryId || !Number.isFinite(payload.tokensBefore)) {
    throw new AgentError('COMPACTION_ENTRY_INVALID', `Compaction payload is invalid: ${entry.id}`);
  }
  return payload;
}

function isSafeCutpoint(entry: SessionEntry): boolean {
  if (entry.type === 'custom' || entry.type === 'branch_summary') return true;
  if (entry.type !== 'message') return false;
  const message = entry.payload as unknown as SessionMessagePayload;
  return message.role !== 'tool';
}

function validateBudget(budget: ContextBudget): void {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new AgentError('CONTEXT_BUDGET_INVALID', `Context budget ${name} must be non-negative`);
    }
  }
  if (budget.reserveTokens >= budget.contextWindow) {
    throw new AgentError(
      'CONTEXT_BUDGET_INVALID',
      'reserveTokens must be lower than contextWindow'
    );
  }
  if (budget.keepRecentTokens >= budget.contextWindow) {
    throw new AgentError(
      'CONTEXT_BUDGET_INVALID',
      'keepRecentTokens must be lower than contextWindow'
    );
  }
}

function totalTokens(path: SessionEntry[], estimate: TokenEstimator): number {
  return path.reduce((sum, entry) => sum + estimate(entry), 0);
}

function lastCompactionIndex(path: SessionEntry[]): number {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    if (path[index].type === 'compaction') return index;
  }
  return -1;
}

export function appendUserText(
  tree: SessionTree,
  content: string,
  id?: string
): SessionEntry {
  return appendMessage(
    tree,
    { role: 'user', content },
    id ? { id } : {}
  );
}
