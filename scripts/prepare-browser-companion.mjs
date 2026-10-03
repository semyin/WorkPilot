import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root, run, cargo } from "./cargo.mjs";
const id = (await readFile(join(root, "extensions/companion/extension-id.txt"), "utf8")).trim();
await run(cargo, [
  "build",
  "-p",
  "workpilot-browser-bridge",
  "--bin",
  "companion",
  "--release",
  "--locked",
]);
const folder = join(root, ".local/browser-companion");
await mkdir(folder, { recursive: true });
const filename = process.platform === "win32" ? "companion.exe" : "companion";
await copyFile(join(root, "target/release", filename), join(folder, filename));
const host = join(folder, "com.workpilot.browser_companion.json");
await writeFile(
  host,
  JSON.stringify(
    {
      name: "com.workpilot.browser_companion",
      description: "WorkPilot explicit task browser connection",
      path: join(folder, filename),
      type: "stdio",
      allowed_origins: ["chrome-extension://" + id + "/"],
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    {
      extensionId: id,
      extensionDirectory: join(root, "extensions/companion"),
      hostManifest: host,
      registered: false,
    },
    null,
    2,
  ),
);
