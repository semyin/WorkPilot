import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createTask } from "./p13-engine-load.mjs";
import { eventually } from "./p13-engine-client.mjs";
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function workbenchTask(context, label, permission = "full_access") {
  const project = join(context.project, label);
  await mkdir(project, { recursive: true });
  const task = await createTask(context.engine, context.profiles.leaf, label);
  const reply = await context.engine.request({
    kind: "configure_task_tools",
    task_id: task,
    settings: {
      root_path: project,
      permission,
      commands_enabled: false,
      review_profile_id: null,
      revision: 0,
    },
  });
  assert.equal(reply.kind, "receipt");
  const raw = (action) => context.engine.request({ kind: "workbench", task_id: task, action });
  const wb = async (action) => {
    const r = await raw(action);
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  const content = async (ref) => {
    let text = "",
      offset = 0;
    while (offset < ref.bytes) {
      const r = await context.engine.request({
        kind: "read",
        query: { kind: "content", object_id: ref.object_id, offset, limit: 65536 },
      });
      assert.equal(r.kind, "content");
      text += r.page.text;
      offset = r.page.next_offset;
    }
    return JSON.parse(text);
  };
  const finish = async (operation, state = "completed") => {
    const op = await eventually(
      async () => {
        const r = await wb({ kind: "operation", operation_id: operation.id });
        return (
          ["completed", "failed", "cancelled", "interrupted"].includes(r.operation.state) &&
          r.operation
        );
      },
      120000,
      80,
    );
    assert.equal(op.state, state, JSON.stringify(op));
    return op.output ? content(op.output) : op;
  };
  const operation = async (action) => {
    const r = await wb(action);
    if (!r.operation) return r;
    if (r.operation.state === "awaiting_approval")
      await wb({
        kind: "approve",
        operation_id: r.operation.id,
        fingerprint: r.operation.fingerprint,
      });
    return finish(r.operation);
  };
  const media = async (action) => {
    const r = await context.engine.request({ kind: "media", task_id: task, action });
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  return { task, project, raw, wb, content, finish, operation, media };
}
export async function browserCycle(context, index, holdMs = 0) {
  const b = await workbenchTask(context, `browser-${index}`);
  const s = await b.wb({
    kind: "browser_control",
    control: { kind: "start", channel: "chromium" },
  });
  assert.equal(s.channel, "chromium");
  assert(s.owned_pid);
  const base = { session_id: s.id, tab_id: s.tabs[0].id };
  const action = (value) => b.operation({ kind: "browser", action: { ...base, ...value } });
  const snapshot = () => action({ kind: "snapshot", query: null });
  let page = await snapshot();
  await action({
    kind: "navigate",
    document: page.document,
    url: context.browserFixture.url + "/page",
  });
  page = await eventually(
    async () => {
      const p = await snapshot();
      return p.frames.some((f) => f.title === "WorkPilot Browser Fixture") && p;
    },
    15000,
    100,
  );
  const input = page.frames.flatMap((f) => f.elements || []).find((e) => e.tag === "input");
  assert(input);
  const marker = `soak-${index}`;
  await action({ kind: "fill", document: page.document, reference: input.reference, text: marker });
  page = await snapshot();
  const button = page.frames.flatMap((f) => f.elements || []).find((e) => e.tag === "button");
  assert(button);
  await action({ kind: "click", document: page.document, reference: button.reference });
  page = await snapshot();
  assert(page.frames.some((f) => f.text?.includes(`Hello, ${marker}`)));
  const link = page.frames
    .flatMap((f) => f.elements || [])
    .find((e) => e.name.includes("Download"));
  assert(link);
  const path = "result.csv",
    before = await b.wb({ kind: "read_file", path });
  await action({
    kind: "download",
    document: page.document,
    reference: link.reference,
    path,
    expected: before.version,
  });
  const bytes = await readFile(join(b.project, path));
  assert.equal(bytes.toString(), "name,value\nWorkPilot,42\n");
  const image = await action({ kind: "screenshot", document: page.document });
  assert(image.image.startsWith("data:image/png;base64,"));
  const imagePath = join(context.output, `browser-${index}.png`);
  await writeFile(imagePath, Buffer.from(image.image.split(",")[1], "base64"));
  if (holdMs) await new Promise((resolve) => setTimeout(resolve, holdMs));
  const closure = context.closeBrowser
    ? await context.closeBrowser({ workbench: b, session: s })
    : await b.wb({ kind: "browser_control", control: { kind: "disconnect", session_id: s.id } });
  return {
    task: b.task,
    session: s.id,
    ownedPid: s.owned_pid,
    closure,
    screenshot: imagePath,
    download: { path: join(b.project, path), sha256: digest(bytes), bytes: bytes.length },
  };
}
const absent = { exists: false, sha256: null, bytes: 0, identity: null };
export async function officeCycle(context, index, format) {
  const b = await workbenchTask(context, `office-${index}`, "request_approval");
  const marker = `Soak ${index} total 42`;
  const recipes = {
    docx: { title: marker, sections: [{ heading: "Evidence", paragraphs: [marker] }] },
    xlsx: {
      title: marker,
      sheets: [
        {
          name: "Data",
          rows: [
            ["Label", "Value"],
            [marker, 42],
          ],
        },
      ],
    },
    pptx: {
      title: marker,
      slides: [{ title: marker, body: ["Product generated Office output", marker] }],
    },
  };
  const name = `result.${format}`;
  const recipe = context.officeRecipe?.(format, index, marker) || recipes[format];
  const made = await b.operation({
    kind: "media",
    effect: {
      kind: "create_document",
      path: name,
      format,
      recipe,
      expected: absent,
    },
  });
  assert.equal(made.assets.length, 1);
  const source = await readFile(join(b.project, name)),
    sourceSha256 = digest(source);
  const file = await b.wb({ kind: "read_file", path: name });
  const { asset } = await b.wb({ kind: "read_document", path: name, expected: file.version });
  const preview = context.previewOffice
    ? await context.previewOffice({ workbench: b, asset, format, index })
    : await b.media({ kind: "preview", asset_id: asset.id, page: 1 });
  assert.equal(preview.source_sha256, sourceSha256);
  assert.equal(preview.conversion, true);
  assert.match(preview.renderer, /LibreOfficeKit/);
  const png = Buffer.from(preview.image.split(",")[1], "base64");
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  const imagePath = join(context.output, `office-${index}-${format}.png`);
  await writeFile(imagePath, png);
  assert.equal(digest(await readFile(join(b.project, name))), sourceSha256);
  const text = await b.media({ kind: "read", asset_id: asset.id, start: 0, limit: 32 });
  assert(JSON.stringify(text).includes("42"));
  return {
    task: b.task,
    format,
    asset: asset.id,
    path: join(b.project, name),
    sha256: sourceSha256,
    preview: imagePath,
    pages: preview.pages,
    renderer: preview.renderer,
  };
}
