import type { GenerationArchitecture } from "./generation/config.js";

export type OpenWikiCommand = "chat" | "init" | "update";
export type OpenWikiOutputMode = "local-wiki" | "repository";

export type OpenWikiRunResult = {
  command: OpenWikiCommand;
  model: string;
  skipped?: boolean;
};

export type OpenWikiRunEvent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool_start";
      call: string;
      id: string;
      input: unknown;
      name: string;
    }
  | {
      type: "tool_end";
      id: string;
      name: string;
      status: "error" | "finished";
    }
  | {
      type: "debug";
      message: string;
    };

export type OpenWikiRunOptions = {
  debug?: boolean;
  isFollowup?: boolean;
  language?: string | null;
  modelId?: string | null;
  onEvent?: (event: OpenWikiRunEvent) => void;
  outputMode?: OpenWikiOutputMode;
  threadId?: string;
  userMessage?: string | null;
  telemetryFile?: string;
  /**
   * Temporary repository-generation implementation override.
   *
   * @default resolved from OPENWIKI_GENERATION_ARCHITECTURE, then legacy.
   */
  generationArchitecture?: GenerationArchitecture;
  /**
   * Maximum concurrent generation graph tasks.
   *
   * @default 4.
   */
  generationConcurrency?: number;
};

export type UpdateRunStatus = "complete" | "partial" | "interrupted";

export type UpdateMetadata = {
  updatedAt: string;
  command: OpenWikiCommand;
  gitHead?: string;
  model: string;
  status?: UpdateRunStatus;
  /**
   * Number of durable workflow obligations remaining.
   *
   * @default 0 for older metadata.
   */
  pendingCount?: number;
  language?: string;
};

export type RunContext = {
  lastUpdate: UpdateMetadata | null;
  language?: string;
  wikiGoal?: string;
};
