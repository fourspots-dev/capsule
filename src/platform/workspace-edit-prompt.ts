export const workspaceEditPrompt = [
  'When editing workspace files, use apply_patch with *** Begin Patch / *** End Patch for multi-line or multi-file changes.',
  'Every Update hunk starts with @@ or @@ anchor text; context lines start with a space, removals with -, additions with +.',
  'Do not calculate unified-diff line counts or send ---/+++ headers to apply_patch.',
  'Use apply_unified_diff only when explicitly handling a strict Git unified diff.',
  'After PATCH_CONTEXT_NOT_FOUND, PATCH_CONTEXT_AMBIGUOUS, PATCH_STALE_FILE or TOOL_RETRY_BLOCKED, re-read the target before retrying.',
].join('\n');
