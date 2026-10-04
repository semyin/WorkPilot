import type { Overview } from "../App";
import type { WorkspacePreferences } from "../generated/contracts";
export type TaskDesktop = {
  overview: Overview | null;
  preferences: WorkspacePreferences;
  connected: boolean;
  onRefresh: () => void;
  onPreferences: (preferences: WorkspacePreferences) => void;
  onSettings: () => void;
  onNotifications?: () => void;
  unreadNotifications?: number;
};
