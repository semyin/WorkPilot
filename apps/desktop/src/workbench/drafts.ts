import type { ExecutionConfig, ToolSettings, MediaAsset } from "../generated/contracts";

// Keep unsent input across workspace remounts (for example notification navigation).
// These are UI drafts only: they never submit themselves and do not survive app exit.
export const messageDrafts = new Map<string, { text: string; attachments: MediaAsset[] }>();
export const creationDrafts = new Map<
  string,
  {
    config: ExecutionConfig;
    tools: ToolSettings;
    constraints: string;
    attachments: MediaAsset[];
  }
>();
