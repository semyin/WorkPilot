import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";
import "./workspace.css";
import "./workbench/styles/foundation.css";
import "./workbench/styles/workbench.css";
import "./workbench/styles/workspace.css";
import "./workbench/styles/overlays.css";
import "./workbench/styles/motion.css";
import "./workbench/styles/menus.css";
import "./workbench/styles/settings.css";
import "./workbench/styles/search.css";
import "./workbench/styles/workspace-controls.css";
import "./workbench/styles/integration.css";
import "./workbench/styles/sidebar.css";
document.documentElement.dataset.motion = localStorage.getItem("workpilot.motion") || "on";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
