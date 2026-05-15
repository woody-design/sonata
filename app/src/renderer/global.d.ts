import type { DuetRuntimeBridge } from "../shared/types";

declare global {
  interface Window {
    duetRuntime: DuetRuntimeBridge;
  }
}

export {};
