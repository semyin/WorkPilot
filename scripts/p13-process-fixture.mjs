// This process is launched only by the benchmark in its isolated project.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const [role, marker] = process.argv.slice(2);
if (!["parent", "child"].includes(role) || !marker)
  throw new Error("Invalid benchmark fixture args");
let child;
if (role === "parent") {
  child = spawn(process.execPath, [fileURLToPath(import.meta.url), "child", marker], {
    windowsHide: true,
    stdio: "ignore",
  });
}
writeFileSync(
  marker + "." + role + ".json",
  JSON.stringify({ pid: process.pid, child: child?.pid || null }),
);
const beat = () => writeFileSync(marker + "." + role + ".beat", String(Date.now()));
beat();
setInterval(beat, 100);
// A failed harness must not leave a permanent background fixture.
setTimeout(() => process.exit(0), 45000);
