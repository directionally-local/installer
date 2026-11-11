import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelUpErrorType, ModelUpResult } from "../model-first-run.js";

/**
 * The GPU first run's contract between dl and Autopilot (Autopilot's src/gpu/handoff.ts is the
 * other side; keep the two in step). Autopilot owns the screens and GPU detection; dl owns
 * `dl model up`.
 *
 * dl → Autopilot, as environment variables on plain `autopilot` (laptop mode, `dl` and the
 * install script's auto-start):
 * - DL_GPU_HANDOFF=PATH: dl can run `dl model up` here. When the person wants a private model
 *   on this machine's GPU, Autopilot writes the request below to PATH (0600, in a 0700 directory
 *   dl made) and exits.
 * - On the relaunch after that, also DL_GPU_RESULT=ok|failed, DL_GPU_ERROR=<error type> (failed
 *   only) and DL_GPU=<the detected GPU as JSON>, so Autopilot says how it went, sends the result
 *   count and doesn't probe the GPUs again.
 *
 * Autopilot → dl, the file at DL_GPU_HANDOFF:
 *   {"version":1,"action":"model-up","gpu":{"vendor":"nvidia","model":"NVIDIA RTX 4090","count":2,"vramGb":24}}
 * `gpu` is optional and only passed back. Anything else (no file, another version or action)
 * is ignored, so an older Autopilot that never writes the file just runs as before, and an
 * older dl that never sets DL_GPU_HANDOFF gets Autopilot's screens without the "this machine"
 * model setup (Autopilot then says to run dl model up).
 */

export const HANDOFF_VERSION = 1;

export interface GpuSummary {
  vendor: "nvidia" | "amd" | "ascend";
  model: string;
  count: number;
  /** Per GPU, the largest card's, in GB. */
  vramGb: number;
}

export interface ModelUpRequest {
  version: 1;
  action: "model-up";
  gpu?: GpuSummary;
}

/** Relaunches after a model-up request, at most: a loop of failures ends in plain Autopilot. */
export const MAX_HANDOFFS = 3;

/** A private directory for the request file; `cleanup` removes it. */
export async function handoffFile(tmp: string = tmpdir()): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmp, "dl-gpu-"));
  return { path: join(dir, "handoff.json"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function gpuFrom(value: unknown): GpuSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.vendor !== "nvidia" && raw.vendor !== "amd" && raw.vendor !== "ascend") return undefined;
  const model = typeof raw.model === "string" ? raw.model.replace(/[^A-Za-z0-9 ._()+/-]/g, "").slice(0, 64) : "";
  const count = typeof raw.count === "number" && Number.isInteger(raw.count) && raw.count >= 0 && raw.count <= 64 ? raw.count : 0;
  const vramGb = typeof raw.vramGb === "number" && Number.isFinite(raw.vramGb) && raw.vramGb >= 0 && raw.vramGb <= 100_000 ? Math.round(raw.vramGb) : 0;
  return { vendor: raw.vendor, model, count, vramGb };
}

/** The request Autopilot wrote, or undefined (none, unreadable, or not one this dl knows). */
export function parseHandoff(text: string): ModelUpRequest | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const object = raw as Record<string, unknown>;
  if (object.version !== HANDOFF_VERSION || object.action !== "model-up") return undefined;
  const gpu = gpuFrom(object.gpu);
  return { version: 1, action: "model-up", ...(gpu ? { gpu } : {}) };
}

/** Reads and removes the request, so each one is acted on once. */
export async function takeHandoff(path: string): Promise<ModelUpRequest | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  await rm(path, { force: true });
  return parseHandoff(text);
}

/** The environment for the relaunch after a model-up request. */
export function resultEnv(result: ModelUpResult, gpu: GpuSummary | undefined): Record<string, string> {
  return {
    DL_GPU_RESULT: result.ok ? "ok" : "failed",
    ...(result.ok ? {} : { DL_GPU_ERROR: result.errorType satisfies ModelUpErrorType }),
    ...(gpu ? { DL_GPU: JSON.stringify(gpu) } : {}),
  };
}
