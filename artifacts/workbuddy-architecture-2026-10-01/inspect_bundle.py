"""Read-only inspection of the installed application archive; never executes app code."""
from pathlib import Path
import json, struct, re, sys, hashlib

RESOURCE_ROOT = Path(r'D:\buddywork\WorkBuddy\resources')
ARCHIVE = RESOURCE_ROOT / 'app.asar'
OUT = Path(__file__).resolve().parent
with ARCHIVE.open('rb') as stream:
    sizes = struct.unpack('<4I', stream.read(16))
    header = json.loads(stream.read(sizes[3]))
files = {}

def walk(node, prefix=''):
    for name, item in node.get('files', {}).items():
        path = prefix + name
        if 'files' in item:
            walk(item, path + '/')
        else:
            files[path] = item

walk(header)

def read(path):
    entry = files[path]
    if entry.get('unpacked'):
        return (RESOURCE_ROOT / 'app.asar.unpacked' / path).read_text(encoding='utf-8', errors='replace')
    with ARCHIVE.open('rb') as stream:
        stream.seek(8 + sizes[1] + int(entry['offset']))
        return stream.read(entry['size']).decode('utf-8', errors='replace')

def excerpts(path, patterns, limit=1, radius=210):
    source = read(path)
    results = []
    for pattern in patterns:
        for match in list(re.finditer(pattern, source))[:limit]:
            results.append({'pattern':pattern, 'line':source.count('\n',0,match.start())+1,
                            'excerpt':source[max(0,match.start()-100):match.end()+radius]})
    return results

if __name__ == '__main__':
    if len(sys.argv) > 1:
        path = sys.argv[1]
        if len(sys.argv) == 2:
            print(read(path))
        else:
            print(json.dumps(excerpts(path,sys.argv[2:]),ensure_ascii=False,indent=2))
    else:
        package = json.loads(read('package.json'))
        cli = json.loads(read('cli/package.json'))
        result = {
            'inspection_date':'2026-10-01',
            'scope':'Installed program package and prior synthetic tests; no account databases, tokens, private memory, or decrypted traffic read.',
            'archive_bytes':ARCHIVE.stat().st_size,
            'archive_entries':len(files),
            'desktop_package':{k:package.get(k) for k in ['name','version','main','dependencies']},
            'cli_package':{k:cli.get(k) for k in ['name','version','description','main','bin']},
            'cli_selected_dependencies':{k:v for k,v in cli['dependencies'].items() if k.startswith(('@genie/','@agentclientprotocol/','@modelcontextprotocol/','@openai/','@anthropic-ai/')) or k in ('e2b','react','openai')},
            'runtime_version_file':(RESOURCE_ROOT.parent/'version').read_text().strip(),
            'main_module_names':[p for p in files if p.startswith('main/') and p.endswith('.js')],
            'db_schema_tables':sorted(set(re.findall(r'CREATE TABLE IF NOT EXISTS\s+([\w]+)',read('main/log-acl-guard.js')))),
            'bundled_runtime_archives':[p.name for p in (RESOURCE_ROOT/'vendor').iterdir()],
            'package_sha256':hashlib.sha256(read('package.json').encode()).hexdigest()
        }
        (OUT/'安装包结构核验.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({k:v for k,v in result.items() if k not in ('main_module_names','desktop_package','cli_selected_dependencies')},ensure_ascii=False,indent=2))
