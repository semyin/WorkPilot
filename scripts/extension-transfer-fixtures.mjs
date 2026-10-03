import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const templateBytes = Buffer.from([0, 255, 1, 254, 13, 10, 0, 77]);
export async function makeExtensionFixtures(directory, url = "http://127.0.0.1:9") {
  const base = join(directory, "通用 技能"),
    tool = join(directory, "项目 插件");
  await mkdir(base, { recursive: true });
  await mkdir(join(tool, "assets"), { recursive: true });
  await mkdir(join(tool, "scripts"));
  await writeFile(
    join(base, "SKILL.md"),
    "---\nname: migration-base\ndescription: Portable base guidance\n---\nPreserve the user's files.\n",
  );
  await writeFile(
    join(tool, "workpilot-plugin.json"),
    JSON.stringify({
      format: 1,
      id: "migration-tool",
      name: "迁移插件 / Portable plugin",
      version: "1.0.0",
      description: "Selected package, binary resource, script and credential declaration",
      skills: ["."],
      dependencies: [{ id: "migration-base", version: "^1.0.0" }],
      servers: [
        {
          id: "remote",
          name: "Authenticated fixture",
          transport: { kind: "http", url: url + "/bearer", auth: "bearer" },
        },
      ],
    }),
  );
  await writeFile(join(tool, "assets/template.bin"), templateBytes);
  await writeFile(
    join(tool, "SKILL.md"),
    "---\nname: migration-tool\ndescription: Portable confirmed script fixture\n---\nUse scripts/run.mjs only when requested.\n",
  );
  await writeFile(
    join(tool, "scripts/run.mjs"),
    "import {writeFileSync} from 'node:fs'; writeFileSync('migration-output.txt','Portable skill ran'); console.log('portable script finished');\n",
  );
  return { base, tool };
}
export async function extensionAdmin(request, task, action) {
  const response = await request({ kind: "extensions", task_id: task, action });
  assert.equal(response.kind, "workbench", JSON.stringify(response));
  return response.data;
}
export async function installExtension(request, task, folder, project, enable = true) {
  const preview = await extensionAdmin(request, task, { kind: "preview", source: folder, project });
  return extensionAdmin(request, task, {
    kind: "confirm",
    draft_id: preview.id,
    digest: preview.version.digest,
    enable,
  });
}
