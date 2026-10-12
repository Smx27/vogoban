import type { AiAnswer } from "../ai/assistant.ts";
import type { QueryPlan, PlanValidation } from "../ai/plan.ts";
import type { EvidenceItem } from "../ai/model.ts";

export function planText(plan: QueryPlan, validation: PlanValidation): string {
  return [
    `Query plan  intent ${plan.intents.join("+")}  source ${plan.source}${plan.environment ? `  environment ${plan.environment}` : ""}  ${plan.direct ? "deterministic answer (no LLM call)" : "LLM explanation over retrieved evidence"}`,
    ...plan.mentions.map((m) => `  entity '${m.text}' -> ${m.status}${m.entity ? ` ${m.entity.kind} ${m.entity.qualifiedName ?? m.entity.name} [${m.entity.repository ?? "-"}] (${m.entity.id}) by ${m.method}${m.from === "conversation" ? " from conversation" : ""}` : m.candidates.length ? ` (${m.candidates.length} candidates)` : ""}`),
    ...plan.steps.map((s, i) => `  ${i + 1}. ${s.tool} ${JSON.stringify(s.args)}  — ${s.purpose}`),
    ...(plan.clarification ? [`  clarification needed: ${plan.clarification.split("\n")[0]}`] : []),
    `  validation: ${validation.ok ? "OK (read-only tools, schema-checked, bounded, in scope)" : `REJECTED\n${validation.errors.map((e) => `    - ${e}`).join("\n")}`}`,
    ...plan.notes.map((n) => `  note: ${n}`),
  ].join("\n");
}

const ev = (e: EvidenceItem) => `  [${e.id}] ${e.status.padEnd(9)} ${e.fact}${e.location ? `  @ ${e.location}` : ""}${e.relationship?.id ? `  (${e.relationship.scope} ${e.relationship.id})` : ""}${e.snapshot ? `  snapshot ${e.snapshot.slice(0, 16)}` : ""}`;

export function answerText(a: AiAnswer, options: { evidence: boolean; plan: boolean }): string {
  const shown = options.evidence ? a.evidence : a.evidence.slice(0, 12);
  const llm = a.provenance.llm;
  return [
    `Answer  [${a.status}; ${a.mode === "llm" ? `LLM explanation (${llm?.provider}/${llm?.responseModel ?? llm?.model})` : a.mode === "deterministic" ? (llm ? "deterministic graph result; LLM used for planning only" : "deterministic graph result, no LLM call") : "deterministic fallback"}]`,
    a.answer,
    ...(a.claims.length ? ["", "Claims", ...a.claims.map((c) => `  ${c.status.padEnd(12)} ${c.statement}${c.evidence.length ? `  (${c.evidence.join(", ")})` : ""}`)] : []),
    ...(a.implications.length ? ["", "Implications", ...a.implications.map((x) => `  - ${x}`)] : []),
    ...(a.unknowns.length || a.limitations.length ? ["", "Unknowns / limitations", ...a.unknowns.map((x) => `  - unknown: ${x}`), ...a.limitations.map((x) => `  - ${x}`)] : []),
    ...(a.evidence.length ? ["", `Evidence (${shown.length} of ${a.evidence.length}${a.provenance.context?.dropped ? `; ${a.provenance.context.dropped} lower-priority items not used` : ""}${options.evidence ? "" : "; --evidence for all"})`, ...shown.map(ev)] : []),
    ...(options.plan ? ["", planText(a.plan, a.validation), ...a.tools.map((t) => `  ran ${t.tool} -> ${t.status} (${t.evidence} evidence, ${t.durationMs} ms${t.truncated ? ", truncated" : ""}${t.error ? `, ${t.error}` : ""})`)] : []),
    "",
    `Provenance: graph ${a.provenance.graph?.repositories.map((r) => `${r.name}@${r.commit?.slice(0, 8) ?? "-"} ${r.status}`).join(", ") ?? "-"}${a.provenance.graph?.metaSnapshot ? `  meta ${a.provenance.graph.metaSnapshot}` : ""}; tools ${a.tools.map((t) => t.tool).join(", ") || "none"}${llm ? `; llm ${llm.provider}/${llm.model} calls=${llm.calls}${llm.usage ? ` tokens=${llm.usage.inputTokens}+${llm.usage.outputTokens}` : ""}` : "; no LLM call"}; record ${a.id}`,
  ].join("\n");
}
