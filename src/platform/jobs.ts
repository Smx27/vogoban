import type { PlatformConfig } from "./config.ts";
import { currentTraceparent } from "./telemetry.ts";
import { sha256, type Job, type JobType, type PlatformStore } from "./store.ts";

export interface EnqueueContext {
  tenantId: string;
  createdBy: string | null;
  correlationId: string | null;
}

/** Graph-writing jobs are exclusive per tenant (one writer per tenant graph store); readers run concurrently. */
const EXCLUSIVE: JobType[] = ["ANALYZE_REPOSITORY", "METAGRAPH_BUILD", "RETENTION"];
const PRIORITY: Record<JobType, number> = { ANALYZE_REPOSITORY: 50, PULL_REQUEST_ANALYSIS: 40, METAGRAPH_BUILD: 60, GOVERNANCE_EVALUATION: 70, SECURITY_ANALYSIS: 70, EXPORT: 80, RETENTION: 200 };

export async function enqueueJob(store: PlatformStore, cfg: PlatformConfig, ctx: EnqueueContext, type: JobType, options: { repositoryId?: string | null; params?: Record<string, unknown>; dedupe?: string | null } = {}): Promise<{ job: Job; deduplicated: boolean }> {
  return store.enqueue({
    tenantId: ctx.tenantId,
    type,
    repositoryId: options.repositoryId ?? null,
    dedupeKey: options.dedupe === null ? null : sha256(`${type}|${options.dedupe ?? JSON.stringify([options.repositoryId ?? null, options.params ?? {}])}`).slice(0, 40),
    params: options.params ?? {},
    priority: PRIORITY[type],
    exclusive: EXCLUSIVE.includes(type),
    maxAttempts: type === "EXPORT" || type === "RETENTION" ? 1 : cfg.worker.maxAttempts,
    createdBy: ctx.createdBy,
    correlationId: ctx.correlationId,
    traceparent: currentTraceparent(),
  });
}

/** Public job view: no lease internals, no worker host details beyond what operators need. */
export function jobDto(j: Job) {
  return {
    id: j.id, type: j.type, status: j.status, repositoryId: j.repositoryId, params: j.params, result: j.result,
    error: j.errorCode ? { code: j.errorCode, class: j.errorClass, message: j.errorMessage } : null,
    attempts: j.attempts, maxAttempts: j.maxAttempts, progress: j.progress, progressMessage: j.progressMessage, cancelRequested: j.cancelRequested,
    graphVersionId: j.graphVersionId, correlationId: j.correlationId, worker: j.worker, createdBy: j.createdBy, createdAt: j.createdAt, startedAt: j.startedAt, completedAt: j.completedAt,
  };
}
