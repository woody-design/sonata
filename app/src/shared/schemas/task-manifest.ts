import type { Task } from "../types/domain";
import { RAW_TERMINAL_POLICY } from "./runtime-report";

export const TASK_MANIFEST_SCHEMA_VERSION = 1 as const;
export const TASK_MANIFEST_SCHEMA_ID = "duet.task-manifest.v1" as const;

export interface TaskManifestV1 {
  schemaId: typeof TASK_MANIFEST_SCHEMA_ID;
  version: typeof TASK_MANIFEST_SCHEMA_VERSION;
  generatedAt: string;
  task: Task;
  rawTerminalPolicy: typeof RAW_TERMINAL_POLICY;
  runtimeReportPath: ".duet/runtime-report.json";
}

export function freshTaskManifestV1(task: Task): TaskManifestV1 {
  return {
    schemaId: TASK_MANIFEST_SCHEMA_ID,
    version: TASK_MANIFEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    task,
    rawTerminalPolicy: RAW_TERMINAL_POLICY,
    runtimeReportPath: ".duet/runtime-report.json",
  };
}

