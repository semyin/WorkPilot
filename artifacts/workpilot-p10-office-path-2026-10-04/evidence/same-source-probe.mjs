import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { launch, create } from '../scripts/tool-test-support.mjs';
import { uploadMedia } from '../scripts/media-transfer-support.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const source = resolve('.test-results/task-archive-final-media-transfer-engine/session-psqPJS/源 项目-offline/中文 报告.docx');
const bytes = await readFile(source);
const root = await mkdtemp(resolve('.test-results/op-'));
const worker = resolve('target/debug/office-runtime/office/program/workpilot-office.exe');
const result = {at:new Date().toISOString(), binarySha256:hash(await readFile(resolve('target/debug/workpilot-engine.exe'))), workerSha256:hash(await readFile(worker)), sourceSha256:hash(bytes), cases:[]};
for (const length of [70, 160, 200]) {
  const dir = join(root, String(length).padEnd(Math.max(4, length - root.length - 1), 'x'));
  let engine;
  try {
    engine = await launch(dir);
    const task = await create(engine, 'responses', 'same-docx-path-test');
    const asset = await uploadMedia(engine.request, task, 'same.docx', bytes);
    const start = performance.now();
    const preview = await engine.request({kind:'media',task_id:task,action:{kind:'preview',asset_id:asset.id,page:1}});
    result.cases.push({dataPathCharacters:join(dir,'test').length, status:preview.kind, response:preview.kind==='error'?preview:{pages:preview.data.pages,source_sha256:preview.data.source_sha256},elapsedMs:Math.round(performance.now()-start)});
  } catch(e) {result.cases.push({dataPathCharacters:join(dir,'test').length,error:String(e.stack||e)});}
  finally {await engine?.close();}
  await writeFile(join(root,'report.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result.cases.at(-1)));
}
result.sourceUnchanged=hash(await readFile(source))===hash(bytes);
await writeFile(join(root,'report.json'),JSON.stringify(result,null,2)+'\n');
console.log(root);
