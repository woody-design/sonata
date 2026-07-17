import type { SonataRuntimeBridge } from "../shared/types";

declare global {
  interface Window {
    sonataRuntime: SonataRuntimeBridge;
  }
}

export {};
