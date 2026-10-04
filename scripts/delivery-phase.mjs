import { join } from "node:path";

// Historical deliveries keep their exact version and directory. A new release
// must get an explicit entry so packaging cannot replace an earlier test binary.
const deliveries = {
  "": {
    phase: "P12-complete",
    version: "0.1.0-alpha.12.15",
    directory: "workpilot-p12-complete-2026-10-04",
    previous: "workpilot-p12-history-restore-2026-10-04",
    config: "p12-bundle.json",
  },
  "--p13": {
    phase: "P13-baseline",
    version: "0.1.0-alpha.13.1",
    directory: "workpilot-p13-baseline-2026-10-04",
    previous: "workpilot-p12-complete-2026-10-04",
    config: "p13-bundle.json",
  },
  "--p13-candidate": {
    phase: "P13-candidate",
    version: "0.1.0-alpha.13.2",
    directory: "workpilot-p13-candidate-2026-10-04",
    previous: "workpilot-p13-baseline-2026-10-04",
    config: "p13-candidate-bundle.json",
  },
  "--p13-r2": {
    phase: "P13-candidate-r2",
    version: "0.1.0-alpha.13.3",
    directory: "workpilot-p13-candidate-2026-10-04-r2",
    previous: "workpilot-p13-candidate-2026-10-04",
    config: "p13-candidate-r2-bundle.json",
  },
  "--p13-r3": {
    phase: "P13-candidate-r3",
    version: "0.1.0-alpha.13.4",
    directory: "workpilot-p13-candidate-2026-10-04-r3",
    previous: "workpilot-p13-candidate-2026-10-04-r2",
    config: "p13-candidate-r3-bundle.json",
  },
};

export function deliveryFor(root, args, version) {
  const selected = args.length <= 1 && deliveries[args[0] || ""];
  if (!selected) throw new Error("Use no argument, --p13, --p13-candidate, --p13-r2 or --p13-r3");
  if (version !== selected.version)
    throw new Error("Wrong delivery version; preserve sealed previous packages");
  return {
    ...selected,
    p13: selected.phase.startsWith("P13"),
    destination: join(root, "artifacts", selected.directory),
    previous: join(root, "artifacts", selected.previous),
    config: join(root, ".local", selected.config),
  };
}
