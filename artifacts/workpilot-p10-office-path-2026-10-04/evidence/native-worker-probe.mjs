import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const bytes=await readFile(resolve('.test-results/task-archive-final-media-transfer-engine/session-psqPJS/源 项目-offline/中文 报告.docx'));
const root=await mkdtemp(resolve('.test-results/ow-'));
const runtime=resolve('target/release/office-runtime');
const report={at:new Date().toISOString(),workerSha256:hash(await readFile(join(runtime,'office/program/workpilot-office.exe'))),sourceSha256:hash(bytes),cases:[]};
for(const length of [100,170,210]) {
  const job=join(root,String(length).padEnd(length-root.length-1,'x'));
  await mkdir(job);
  await writeFile(join(job,'input.docx'),bytes);
  const out=await new Promise((resolve,reject)=>{
    const child=spawn('target/debug/examples/office_probe.exe',[runtime,job,'docx'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',b=>stdout+=b);
    child.stderr.on('data',b=>stderr+=b);
    child.on('error',reject);
    child.on('exit',code=>resolve({code,stdout,stderr}));
  });
  report.cases.push({jobCharacters:job.length,...out});
  console.log(JSON.stringify(report.cases.at(-1)));
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');
}
console.log(root);
