import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Read only the two WorkPilot host registrations. No browser profiles or credentials.
export function browserRegistrationSnapshot() {
  const script = String.raw`
$ErrorActionPreference='Stop'
$items=@()
foreach($hive in @('CurrentUser','LocalMachine')) {
  foreach($view in @('Registry32','Registry64')) {
    $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive,[Microsoft.Win32.RegistryView]::$view)
    try {
      foreach($vendor in @('Google\Chrome','Microsoft\Edge','Chromium')) {
        foreach($hostName in @('com.workpilot.browser_companion','com.workpilot.browser_probe')) {
          $path='Software\'+$vendor+'\NativeMessagingHosts\'+$hostName
          $key=$base.OpenSubKey($path)
          try {
            $values=@()
            if($key){foreach($name in ($key.GetValueNames()|Sort-Object)){$values+=@{name=$name;kind=$key.GetValueKind($name).ToString();value=$key.GetValue($name)}}}
            $items+=@{hive=$hive;view=$view;path=$path;present=($null -ne $key);values=$values;subkeys=$(if($key){@($key.GetSubKeyNames()|Sort-Object)}else{@()})}
          } finally {if($key){$key.Dispose()}}
        }
      }
    } finally {$base.Dispose()}
  }
}
$items|ConvertTo-Json -Depth 7 -Compress
`;
  const text = execFileSync(
    join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  // Sort object keys as PowerShell Hashtable property enumeration need not be stable.
  const stable = (value) =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((k) => [k, stable(value[k])]),
          )
        : value;
  return createHash("sha256")
    .update(JSON.stringify(stable(JSON.parse(text))))
    .digest("hex");
}
if (process.argv[1]?.endsWith("browser-registration-snapshot.mjs"))
  console.log(browserRegistrationSnapshot());
