import type { AiLimits, EvidenceItem, ToolResult } from "./model.ts";

export interface BuiltContext {
  evidence: EvidenceItem[];
  considered: number;
  duplicates: number;
  dropped: number;
  truncated: boolean;
  limitations: string[];
  tokenEstimate: number;
  block: string;
  nonce: string;
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** Graph text (names, descriptions, messages) is untrusted: it is JSON-encoded and '<' is escaped so it cannot close the data boundary. */
const encode = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/**
 * Normalizes tool results into a bounded, deduplicated, prioritized evidence set.
 * Priority: 1 direct evidence, 2 relevant paths, 3 impact analysis, 4 governance/security, 5 ownership, 6 supporting metadata.
 * Evidence from the primary (first) step outranks evidence of the same priority from supporting steps.
 */
export function buildContext(question: string, results: ToolResult[], limits: AiLimits, tokenBudget: number): BuiltContext {
  const nonce = Math.random().toString(36).slice(2, 10);
  const all = results.flatMap((r, step) => r.evidence.map((e, index) => ({ e, step, index })));
  const byKey = new Map<string, { e: EvidenceItem; step: number; index: number }>();
  for (const x of all) {
    const prev = byKey.get(x.e.key);
    if (!prev || x.e.priority < prev.e.priority) byKey.set(x.e.key, x);
  }
  const ordered = [...byKey.values()].sort((a, b) => a.e.priority - b.e.priority || a.step - b.step || a.index - b.index);
  const limitations: string[] = [];
  let selected = ordered.slice(0, limits.maxEvidence).map((x) => x.e);
  if (ordered.length > selected.length) limitations.push(`evidence limited to ${limits.maxEvidence} of ${ordered.length} items (lowest priority omitted)`);
  const header = (evidence: EvidenceItem[]) => ({
    question,
    tools: results.map((r) => ({ tool: r.tool, input: r.input, status: r.status, summary: r.summary.slice(0, 20), unknowns: r.unknowns, truncated: r.truncated, graph: r.graph, ...(r.error ? { error: r.error } : {}) })),
    evidence: evidence.map((e, i) => ({ id: `E${i + 1}`, status: e.status, fact: e.fact, source: e.source?.id ?? null, target: e.target?.id ?? null, relationship: e.relationship, path: e.path, repository: e.repository, environment: e.environment, snapshot: e.snapshot, location: e.location })),
  });
  let body = encode(header(selected));
  while (estimateTokens(body) > tokenBudget && selected.length > 1) {
    selected = selected.slice(0, Math.max(1, Math.floor(selected.length * 0.8)));
    body = encode(header(selected));
  }
  if (selected.length < Math.min(ordered.length, limits.maxEvidence)) limitations.push(`context budget (${tokenBudget} tokens) reduced evidence to ${selected.length} items`);
  const truncatedTools = results.filter((r) => r.truncated).map((r) => r.tool);
  if (truncatedTools.length) limitations.push(`results of ${[...new Set(truncatedTools)].join(", ")} were truncated by traversal or result limits; the answer is based on bounded evidence`);
  const evidence = selected.map((e, i) => ({ ...e, id: `E${i + 1}` }));
  return {
    evidence,
    considered: all.length,
    duplicates: all.length - byKey.size,
    dropped: ordered.length - selected.length,
    truncated: limitations.length > 0,
    limitations,
    tokenEstimate: estimateTokens(body),
    block: `<graph_data id="${nonce}">\n${body}\n</graph_data id="${nonce}">`,
    nonce,
  };
}
