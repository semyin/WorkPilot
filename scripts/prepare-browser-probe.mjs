import { createHash, generateKeyPairSync } from "node:crypto";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { root, run, cargo } from "./cargo.mjs";

const manifestPath = join(root, "extensions/browser/manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!manifest.key) {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  manifest.key = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}
const id = [
  ...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16),
]
  .flatMap((byte) => [byte >> 4, byte & 15])
  .map((n) => String.fromCharCode(97 + n))
  .join("");
await run(cargo, ["build", "-p", "workpilot-browser-bridge", "--release", "--locked"]);
const directory = join(root, ".local/browser-host");
await mkdir(directory, { recursive: true });
const filename = "workpilot-browser-bridge" + (process.platform === "win32" ? ".exe" : "");
const executable = join(directory, filename);
await copyFile(join(root, "target/release", filename), executable);
await writeFile(
  join(directory, "com.workpilot.browser_probe.json"),
  JSON.stringify(
    {
      name: "com.workpilot.browser_probe",
      description: "WorkPilot P00 native messaging probe",
      path: executable,
      type: "stdio",
      allowed_origins: ["chrome-extension://" + id + "/"],
    },
    null,
    2,
  ),
);
await writeFile(join(directory, "extension-id.txt"), id + "\n");
console.log(
  JSON.stringify(
    {
      extensionId: id,
      extensionDirectory: join(root, "extensions/browser"),
      hostManifest: join(directory, "com.workpilot.browser_probe.json"),
      registered: false,
    },
    null,
    2,
  ),
);
