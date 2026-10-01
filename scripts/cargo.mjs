import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const cargoBin = join(process.env.CARGO_HOME || join(homedir(), ".cargo"), "bin");
export const cargo = join(cargoBin, process.platform === "win32" ? "cargo.exe" : "cargo");
export function rustEnv(extra = {}) {
  return { ...process.env, PATH: cargoBin + delimiter + process.env.PATH, ...extra };
}
export async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: rustEnv(),
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(command + " exited with " + (code ?? signal)));
    });
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!existsSync(cargo))
    throw new Error("Rust is missing. See docs/development/P00-开发与验证.md");
  await run(cargo, process.argv.slice(2));
}
