// src/lib/vsm/memo.ts — Block 12: the per-request memo (L1 analog). One Map per request, stashed
// on context.locals so every VSM read in the same invocation shares it. Not cross-request.
export function getRequestMemo(locals: any): Map<string, unknown> {
  if (!locals) return new Map();
  if (!locals.__vsmMemo) locals.__vsmMemo = new Map<string, unknown>();
  return locals.__vsmMemo as Map<string, unknown>;
}
