import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installExtension, extensionAdmin } from "./extension-transfer-fixtures.mjs";

export function skillFiles(slug, version, content = "Preserve the user's files.") {
  return [
    {
      path: "workpilot-plugin.json",
      text: JSON.stringify({
        format: 1,
        id: slug,
        name: slug,
        version,
        description: "Retained extension history fixture",
        skills: ["."],
        dependencies: [],
        servers: [],
      }),
    },
    {
      path: "SKILL.md",
      text: `---\nname: ${slug}\ndescription: Retained migration skill\n---\n${content}\n`,
    },
  ];
}
export async function writeSkillPackage(folder, slug, version, content) {
  await mkdir(folder, { recursive: true });
  const files = skillFiles(slug, version, content);
  for (const file of files) await writeFile(join(folder, file.path), file.text);
  return files;
}
export async function makeHistoryFixture(request, task, directory) {
  const source = join(directory, "history"),
    removedSource = join(directory, "removed");
  await writeSkillPackage(source, "migration-history", "1.0.0", "Original saved skill.");
  const first = await installExtension(request, task, source, false, false);
  await writeSkillPackage(source, "migration-history", "2.0.0", "Updated saved skill.");
  const current = await installExtension(request, task, source, false, false);
  await writeSkillPackage(source, "migration-history", "3.0.0", "Pending draft text.");
  const draft = await extensionAdmin(request, task, { kind: "preview", source, project: false });
  await writeSkillPackage(removedSource, "migration-removed", "1.0.0", "Keep uninstalled.");
  const installed = await installExtension(request, task, removedSource, false, false);
  const removed = (
    await extensionAdmin(request, task, {
      kind: "uninstall",
      installation_id: installed.id,
      revision: installed.revision,
    })
  ).installation;
  return { first, current, removed, draft };
}
