// DPAPI plaintext flows only through a private child pipe, never an argument, environment value or file.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

if (!process.env.WORKPILOT_ENGINE_BINARY)
  throw new Error("Set WORKPILOT_ENGINE_BINARY to the frozen candidate first");
const script = resolve("scripts/p13-real-model-check.mjs");
const test = spawn(process.execPath, [script, ...process.argv.slice(2)], {
  windowsHide: true,
  stdio: ["pipe", "inherit", "inherit"],
});
test.stdin.on("error", () => {});
const decryption = `
$ErrorActionPreference = 'Stop'
$secure = (Get-Content -LiteralPath $env:WORKPILOT_REAL_CREDENTIAL_FILE -Raw).Trim() | ConvertTo-SecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $configuration = @{origin='https://ws-ky8utskqnjn8b091.cn-beijing.maas.aliyuncs.com';key=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)}
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  [Console]::Out.Write(($configuration | ConvertTo-Json -Compress))
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $configuration = $null
  $secure.Dispose()
}
`;
const decryptEnv = {
  ...process.env,
  WORKPILOT_REAL_CREDENTIAL_FILE: resolve(
    process.env.WORKPILOT_REAL_CREDENTIAL_FILE || ".local/p13-test-credential.dpapi",
  ),
};
// A caller running PowerShell 7 can otherwise point Windows PowerShell 5 at incompatible modules.
delete decryptEnv.PSModulePath;
const decrypt = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", decryption], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: decryptEnv,
});
decrypt.stderr.resume(); // Never print a decryption exception that could quote its input.
decrypt.stdout.pipe(test.stdin);
const unlocked = once(decrypt, "exit");
const done = once(test, "exit");
test.on("exit", () => {
  if (decrypt.exitCode === null) decrypt.kill();
});
const [unlockCode] = await unlocked;
if (unlockCode !== 0)
  console.error("Could not unlock the test credential under the current Windows user.");
const [testCode] = await done;
process.exitCode = unlockCode === 0 && testCode === 0 ? 0 : 1;
