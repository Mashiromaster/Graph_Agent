import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import type {
  DeepSeekHarnessOptions,
  HarnessNotification,
  RunResult,
} from "@deepseek-ai/dsh-sdk-client";

export interface HarnessRunOptions {
  readonly sessionId: string;
  readonly onNotification?: (notification: HarnessNotification) => void;
}

export interface HarnessRuntime {
  run(input: string, options: HarnessRunOptions): Promise<RunResult>;
  close(): Promise<void>;
}

export type HarnessRuntimeFactory = (
  options: DeepSeekHarnessOptions,
) => HarnessRuntime;

export const defaultHarnessRuntimeFactory: HarnessRuntimeFactory = (options) =>
  new DeepSeekHarness(options);

export type { DeepSeekHarnessOptions, HarnessNotification, RunResult };
