import type { RuntimeVersions } from "../shared/versions";

declare global {
  interface Window {
    paperweave: {
      getRuntimeVersions(): Promise<RuntimeVersions>;
      platform: string;
    };
  }
}

export {};
