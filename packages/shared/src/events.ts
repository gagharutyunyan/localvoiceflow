import { z } from "zod";
import { DictationStatusSchema } from "./settings.js";

/**
 * Stages pushed over SSE. The macOS agent maps these onto HUD text, so the set is
 * intentionally small and stable.
 */
export const PipelineStageSchema = z.enum([
  "received",
  "transcribing",
  "transcribed",
  "correcting",
  "completed",
  "failed",
  "cancelled",
]);
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pipeline"),
    dictationId: z.string(),
    stage: PipelineStageSchema,
    status: DictationStatusSchema,
    at: z.string(),
    /**
     * The transcript as of this stage — set on `transcribed` so the agent HUD can show the
     * user their words while the LLM is still working. SSE requires the same token as the
     * history API, which already returns full texts, so this widens no trust boundary.
     */
    text: z.string().optional(),
    /** Never contains user text — only lengths, codes and durations. */
    detail: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  }),
  z.object({
    type: z.literal("stt-status"),
    at: z.string(),
    ready: z.boolean(),
    state: z.string(),
    model: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("settings-changed"),
    at: z.string(),
  }),
  z.object({
    type: z.literal("hello"),
    at: z.string(),
    version: z.string(),
  }),
]);

export type ServerEvent = z.infer<typeof ServerEventSchema>;

export const HEALTH_STATES = ["ok", "degraded", "error"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export interface StatusResponse {
  version: string;
  state: HealthState;
  uptimeMs: number;
  port: number;
  stt: {
    ready: boolean;
    state: string;
    backend: string;
    model?: string;
    device?: string;
    loadMs?: number;
    error?: string;
    restarts?: number;
  };
  correction: {
    provider: string;
    model: string;
    effort: string;
    profile: string;
  };
  lastDictation?: {
    id: string;
    createdAt: string;
    status: string;
    totalLatencyMs?: number;
    sttLatencyMs?: number;
    llmLatencyMs?: number;
  };
  lastError?: {
    at: string;
    code: string;
    message: string;
  };
  /** Reported by the macOS agent; core cannot query TCC on its own. */
  permissions: {
    microphone: PermissionState;
    accessibility: PermissionState;
    inputMonitoring: PermissionState;
    reportedAt?: string;
    agentConnected: boolean;
  };
}

export const PermissionStateSchema = z.enum(["granted", "denied", "unknown", "not-determined"]);
export type PermissionState = z.infer<typeof PermissionStateSchema>;

export const AgentStatusSchema = z.object({
  microphone: PermissionStateSchema,
  accessibility: PermissionStateSchema,
  inputMonitoring: PermissionStateSchema,
  agentVersion: z.string().max(40).optional(),
  /** False when the Fn event tap could not be installed on this machine. */
  fnTapActive: z.boolean().optional(),
  fnTapError: z.string().max(300).optional(),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
