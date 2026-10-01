from pathlib import Path
from collections import Counter
from html import escape
import base64, json, zipfile, struct, xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
SAMPLES = ROOT / 'samples'
features = []
for line in (ROOT / 'features.txt').read_text(encoding='utf-8').splitlines():
    if line.strip():
        group, name, purpose, entry, status, result = line.split('|')
        features.append(dict(group=group, name=name, purpose=purpose, entry=entry, status=status, result=result))
extensions = [dict(zip(('name','group','purpose'), line.split('|'))) for line in (ROOT/'extensions.txt').read_text(encoding='utf-8').splitlines() if line.strip()]
counts = Counter(f['status'] for f in features)
groups = list(dict.fromkeys(f['group'] for f in features))

def cells(path):
    ns = {'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(path) as z:
        x = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
        out = {}
        for c in x.findall('.//s:c',ns):
            out[c.get('r')] = {'value':c.findtext('s:v',None,ns), 'formula':c.findtext('s:f',None,ns)}
        return out, len([n for n in z.namelist() if n.startswith('xl/charts/chart') and n.endswith('.xml')])

original, charts = cells(SAMPLES/'销售数据.xlsx')
modified_path = Path(r'C:\Users\semyi\WorkBuddy\功能实测1001\附件读取测试.xlsx')
modified, _ = cells(modified_path)
saved = modified.get('B2',{}).get('value') == '21'
if saved:
    (SAMPLES/'AI修改后的测试表.xlsx').write_bytes(modified_path.read_bytes())
for f in features:
    if f['name']=='AI 修改表格':
        f['result'] += ' 已点击保存，并独立检查保存后的文件B2=21。' if saved else ' 已操作保存，但磁盘原文件B2未变为21，编辑预览成功、原文件落盘未通过。'
        if not saved: f['status']='部分通过'
    if f['name']=='Excel 图表':
        f['status']='通过' if charts else '部分通过'
        f['result']=f'生成的工作簿内含{charts}份原生图表定义；内置预览已核验数据，未对每个图表样式做审美评分。'
counts = Counter(f['status'] for f in features)

png_dims = {}
for p in SAMPLES.glob('*.png'):
    b=p.read_bytes()
    if b[:8] == b'\x89PNG\r\n\x1a\n': png_dims[p.name] = struct.unpack('>II',b[16:24])
with zipfile.ZipFile(SAMPLES/'销售汇报.pptx') as z:
    slide_count = len([n for n in z.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml')])
qa = {'core_rows':len(features),'connector_entries':len(extensions),'categories':len(groups),'statuses':dict(counts),'original_B2':original.get('B2'),'original_D2':original.get('D2'),'original_D5':original.get('D5'),'xlsx_charts':charts,'ppt_slides':slide_count,'png_dimensions':png_dims,'modified_file_B2':modified.get('B2'),'modified_saved':saved}
wns = {'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
marker = '补测验收：这段文字由 WorkBuddy 内置编辑器手动添加。'
word_checks = {}
for name in ('编辑补测-销售简报.docx','另存验证-销售简报.docx'):
    with zipfile.ZipFile(SAMPLES/name) as z:
        root = ET.fromstring(z.read('word/document.xml'))
        paragraphs = [''.join(p.itertext()) for p in root.findall('.//w:p',wns)]
        word_checks[name] = {
            'marker_paragraphs':sum(marker in p for p in paragraphs),
            'marker_bold_runs':sum(marker in ''.join(r.itertext()) and r.find('w:rPr/w:b',wns) is not None for r in root.findall('.//w:r',wns))
        }
ans = {'a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
with zipfile.ZipFile(SAMPLES/'编辑补测-销售汇报.pptx') as z:
    title_text = ''.join(ET.fromstring(z.read('ppt/slides/slide1.xml')).itertext())
    note_text = '\n'.join(''.join(ET.fromstring(z.read(n)).itertext()) for n in z.namelist() if n.startswith('ppt/notesSlides/notesSlide') and n.endswith('.xml'))
plan = (SAMPLES/'松果咖啡周末阅读日-小方案.md').read_text(encoding='utf-8')
poster = plan.split('**正文**',1)[1].split('\n',1)[1].split('\n\n',1)[0]
qa['followup'] = {
    'word_checks':word_checks,
    'ppt_title_saved':'销售汇报 · 编辑补测已完成' in title_text,
    'ppt_notes_saved':'补测备注：先讲总收入2020元，再说明三款产品的差异。' in note_text,
    'team_document_lines':len(plan.splitlines()),
    'team_poster_characters_with_punctuation':len(poster),
    'team_checklist_items':sum(x in plan for x in ['【物料准备】','【现场执行】','【收尾沉淀】'])
}
(ROOT/'验收记录.json').write_text(json.dumps(qa,ensure_ascii=False,indent=2),encoding='utf-8')

def e(s): return escape(str(s),quote=True)
def media(name,mime): return f'data:{mime};base64,'+base64.b64encode((SAMPLES/name).read_bytes()).decode()
def badge(status):
    cls = {'通过':'ok','部分通过':'part','未跑通':'fail','已查看':'seen','未验证':'unverified'}[status]
    return f'<span class="badge {cls}">{status}</span>'
def filelink(name,label=None): return f'<a href="samples/{e(name)}" target="_blank">{e(label or name)}</a>'

scenario_data = [
('01','计算、建议与翻译','仅问答','A产品20×35=700；B产品15×48=720；合计1420；占比和英文翻译已目视核对。','建议中仍可能加入数据未证明的推断，不能把计算正确等同于建议必然正确。'),
('02','本地助理整理待办','完成','海报完成、明早校对、明午提交，生成三项待办和各自的验收标准。','没有建立真实提醒，没有往微信发送信息。'),
('03','四类办公文件','完成，转换除外','真实生成并打开表格、1页Word、3页PPT、1页PDF，销售收入合计2020。','PDF为同内容重新生成，并未完成Word直接转PDF。'),
('04','内容创作专家','完成','三天排期、小红书、朋友圈、30秒视频分镜均有完整草稿。','虚构品牌被补充了桌数、营业时间等创作设定；用于真实商家前应替换。'),
('05','一次性定时任务','止于权限确认','设置了测试名称、内容、单次时间，展开周期选项。','完全访问确认未通过，表单已取消，没有留下自动运行任务。'),
('06','资料库与一键网页','完成','创建并编辑虚构文档，自动保存，再通过魔棒生成咖啡介绍网页。','本次没有测试数据表的跨设备双向同步。'),
('07','方形插画','完成','生成森林咖啡馆松鼠插画，实际文件尺寸见样例区。','画面带AI生成标识。'),
('08','咖啡馆短视频','部分符合','生成并完整播放5秒视频，画面有咖啡、热气、书和窗边场景。','实际1344×768，与要求的严格16:9存在比例偏差。'),
('09','联网与浏览器','通过替代路径完成','官方能力检索返回结果；网页读取得到Example Domain与正文。','已装浏览器技能缺组件，实际借本机Chrome完成；临时文件清理被取消。'),
('10','局部编辑图片','完成','沿用原图只将桌边杯子改为蓝色，原图仍在。','肉眼核验局部变化；未独立复核WorkBuddy自述的像素变化百分比。'),
('11','附件首轮发送','首轮失败，后续已恢复归档','本地附件可加入，但发送出现4012，并有文件被其他任务处理的提示；曾归档，在场景19中恢复。','根因未查定，不把单次错误推断为附件功能整体不可用。'),
('12','先计划，再做计算器','完成','先生成方案，明确实施后得到可运行HTML；输入10/25=15与60%，10/0也能合理显示。','初次确认卡片后仍返回计划，补发实施要求后才执行。'),
('13','附件重测与AI改表','经手动打开后完成','C、D盘直接路径读取不稳；打开右侧表格后成功读数与公式。再把销量20改21，重算为735、46、2055。', '已独立核验保存文件中的B2为21。' if saved else '右侧修改已成功，但原文件保存结果未通过独立验证。'),
('14','创建个人专家并召唤','完成','创建三句话助手，进入“我的专家”核验存在，实际召唤回答待办问题，输出三条中文短句。','创建流程曾自述注册可能有问题，但实际列表与调用均成功；以界面和成品为准。'),
]
followup_path = ROOT/'补测记录.json'
if followup_path.exists():
    for trial in json.loads(followup_path.read_text(encoding='utf-8')).get('tests', []):
        if trial.get('report'):
            scenario_data.append((trial['id'], trial['name'], trial['status'], trial['summary'], trial.get('note','')))
scenarios=''.join(f'<article class="trial"><span class="trial-id">{i}</span><div><h3>{e(title)} <small>{e(status)}</small></h3><p>{e(result)}</p><p class="muted">{e(note)}</p></div></article>' for i,title,status,result,note in scenario_data)

sections=[]
for group in groups:
    rows=[f for f in features if f['group']==group]
    body=[]
    for n,f in enumerate(features,1):
        if f['group']!=group: continue
        search=' '.join(f.values())
        body.append(f'<tr class="feature-row" data-status="{e(f["status"])}" data-group="{e(group)}" data-search="{e(search)}"><td><span class="row-no">{n:03d}</span><strong>{e(f["name"])}</strong>{badge(f["status"])}</td><td>{e(f["purpose"])}<div class="entry">入口：{e(f["entry"])}</div></td><td>{e(f["result"])}</td></tr>')
    sections.append(f'<details class="feature-group" open data-group="{e(group)}"><summary>{e(group)} <span>{len(rows)}项</span></summary><div class="table-wrap"><table><thead><tr><th>功能与验证状态</th><th>能做什么 / 从哪里进入</th><th>本次做了什么、结果如何</th></tr></thead><tbody>{"".join(body)}</tbody></table></div></details>')
extrows=''.join(f'<tr class="ext-row" data-search="{e(" ".join(x.values()))}"><td>{i:03d}</td><td><strong>{e(x["name"])}</strong></td><td>{e(x["group"])}</td><td>{e(x["purpose"])}</td><td><span class="badge seen">目录已查看</span></td></tr>' for i,x in enumerate(extensions,1))

apps=[('通达信','证券研究'),('企鹅教师助手','教学准备；点击后要求读取云端任务授权，未授权'),('美图设计室','视觉设计'),('腾讯自选股','市场与自选股'),('腾讯电子签AI合同助手','合同工作'),('Alpha派·Lite','研究资料与报告'),('广发证券','证券研究'),('腾讯公益智能助手','公益机构事务'),('哪吒AI运营','运营工作台'),('东方财富妙想','投资研究'),('易方达基金','基金信息'),('腾讯健康 BioMed AI','医学资料与研究')]
appcards=''.join(f'<div class="mini"><b>{e(n)}</b><span>{e(d)}</span></div>' for n,d in apps)
artifacts=''.join(filelink(n,label) for n,label in [
('销售数据.xlsx','Excel：带公式的销售表'),('销售简报.docx','Word：一页简报'),('销售汇报.pptx','PPT：三页汇报'),('销售简报.pdf','PDF：销售简报'),('咖啡售价计算器.html','打开售价计算器'),('资料库生成网页.html','打开资料库生成网页'),('内容专家草稿.md','内容专家完整草稿')])
if saved: artifacts += filelink('AI修改后的测试表.xlsx','AI修改后：销量21的表格')
artifacts += ''.join(filelink(n,label) for n,label in [
    ('编辑补测-销售简报.docx','补测Word：新增且加粗段落'),
    ('另存验证-销售简报.docx','补测Word：另存为副本'),
    ('编辑补测-销售汇报.pptx','补测PPT：修改标题和备注'),
    ('松果咖啡周末阅读日-小方案.md','专家团：活动完整方案'),
    ('Remove_the_watermark_text_and__2026-10-01T10-01-26.png','专家团：最终配图'),
    ('A_warm__cozy_illustrated_scene_2026-10-01T10-00-49.png','专家团：备选配图')
])
followup_summary = '''<section id="followup"><h2>第二轮补测：从入口走到实际结果</h2>
<div class="intro-grid"><div class="panel"><h3>这轮新增验证</h3><ul>
<li><b>文档编辑：</b>Word手工编辑、加粗、撤销重做、保存和另存；PPT改标题、写备注、放映翻页。</li>
<li><b>资料整理：</b>数据表录入、排序、筛选、分组、隐藏列；新建资料夹、上传Word、存网页链接。</li>
<li><b>任务操作：</b>停止生成后继续提问、复制、重试、归档恢复、搜索、侧栏筛选。</li>
<li><b>模型调用：</b>快速、均衡、极致均实际回复成功；均衡与极致本次都使用Hy4 preview。</li>
<li><b>项目管理：</b>说明、优先级和状态可保存；子待办完成度从0/1变为1/1；项目AI读取结果另见场景21。</li>
</ul><p class="muted">下方清单已更新验证状态。一个条目“通过”，指本次写明的操作通过，不表示它的所有按钮和极端情况都已测完。</p></div>
<div class="panel"><h3>专家团的真实交付</h3><img src="__TEAM_IMG__" alt="专家团生成的松鼠读书配图，右下角仍有AI生成标识" style="display:block;width:100%;max-width:330px;margin:12px auto;border-radius:10px">
<p>策划、文案和配图三位成员均完成了自己的任务。汇总方案包含活动主题、<b>104字</b>海报正文和三条执行清单；两张图均为<b>1024×1024</b>。</p>
<p class="muted">图像仍带“AI生成”标识。原方案中的水印机制解释属于WorkBuddy自述，未独立验证。方案和配图均已加入上方样例。</p></div></div></section>'''

html='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WorkBuddy 功能实测报告 · 2026-10-01</title>
<style>
:root{--bg:#f4f6f5;--ink:#18342c;--muted:#687871;--line:#dce5df;--paper:#fff;--accent:#12684e}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.75 "Microsoft YaHei","PingFang SC",sans-serif}a{color:#08634b;text-decoration:none}a:hover{text-decoration:underline}button,select,input{font:inherit}button{cursor:pointer}.wrap{max-width:1300px;margin:auto;padding:0 36px}.hero{background:#153e32;color:#f7fbf8;padding:52px 0 44px}.eyebrow{font-size:13px;letter-spacing:2px;color:#bdd4c8}.hero h1{font-size:40px;line-height:1.2;letter-spacing:-1px;margin:18px 0}.hero p{max-width:860px;color:#d4e5dc;margin:0;font-size:17px}.hero .meta{font-size:13px;margin-top:22px;color:#a9c8b8}.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin:28px 0}.stat{padding:18px 21px;background:white;border:1px solid var(--line);border-radius:12px}.stat b{font-size:31px;line-height:1.2;display:block}.stat span{font-size:13px;color:var(--muted)}section{margin:38px 0}.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:20px}h2{font-size:26px;margin:0 0 16px;letter-spacing:-.5px}h3{font-size:17px;margin:0 0 8px}p{margin:8px 0}.muted{color:var(--muted);font-size:13px}.intro-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.panel{background:white;border:1px solid var(--line);border-radius:14px;padding:24px}.panel ul{padding-left:20px;margin:10px 0 0}.panel li{margin:9px 0}.scope{background:#edf2e9;border-left:4px solid #8d9e6a;padding:19px 22px;border-radius:0 12px 12px 0;margin-top:20px}.badge{font-size:11px;border-radius:5px;padding:2px 7px;display:inline-block;font-weight:normal;white-space:nowrap}.ok{background:#e0f1e5;color:#216543}.part{background:#fff1d6;color:#8b5b05}.seen{background:#edf0f4;color:#576479}.fail{background:#fae6e4;color:#a4423a}.unverified{background:#efedf1;color:#7a647d}.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:#61726a;margin:14px 0}.toolbar{position:sticky;top:0;z-index:5;background:#f4f6f5f5;border:1px solid var(--line);backdrop-filter:blur(10px);padding:14px;border-radius:12px;display:flex;gap:10px;flex-wrap:wrap;margin:22px 0 14px;box-shadow:0 5px 18px #153e3208}.toolbar input{flex:1;min-width:240px}.toolbar input,.toolbar select{border:1px solid #cbd8d0;background:#fff;border-radius:7px;padding:9px 12px;color:var(--ink)}.toolbar button,.action{border:1px solid #cbd8d0;background:white;color:#234b3b;border-radius:7px;padding:8px 12px}.toolbar button:hover,.action:hover{background:#e8f0eb}.result-line{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--muted);margin:8px 0 16px}.feature-group{background:white;border:1px solid var(--line);border-radius:12px;margin:12px 0;overflow:hidden}.feature-group summary,.connector-box summary{cursor:pointer;padding:16px 20px;font-weight:bold;font-size:17px}.feature-group summary span{font-size:12px;color:var(--muted);font-weight:normal;margin-left:12px}.feature-group[open] summary{border-bottom:1px solid var(--line);background:#f8fbf8}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;text-align:left;font-size:13px;table-layout:fixed}th{font-size:12px;font-weight:normal;color:#718078;background:#fafcfa;padding:10px 18px}td{padding:15px 18px;vertical-align:top;border-top:1px solid #edf1ed;word-break:break-word}td:first-child{width:24%}th:nth-child(1){width:24%}th:nth-child(2){width:30%}th:nth-child(3){width:46%}td strong{display:block;margin-bottom:6px;font-size:14px}.row-no{font-size:10px;color:#9aa89f;display:block;letter-spacing:1px}.entry{font-size:11px;color:#7a877f;margin-top:6px}.trial-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.trial{background:#fff;border:1px solid var(--line);border-radius:12px;padding:19px;display:flex;gap:14px}.trial-id{font-size:22px;font-weight:bold;color:#a3b8a9}.trial h3{font-size:15px}.trial h3 small{font-size:10px;color:#6f8377;font-weight:normal;display:block}.trial p{font-size:13px}.artifact-links{display:flex;flex-wrap:wrap;gap:10px;margin:15px 0 24px}.artifact-links a{background:#fff;border:1px solid #c9d9cd;border-radius:8px;padding:10px 15px;font-size:13px}.visuals{display:grid;grid-template-columns:1fr 1fr 1.2fr;gap:18px}.visuals figure{margin:0;padding:10px;border:1px solid var(--line);border-radius:12px;background:#fff}.visuals img,.visuals video{display:block;width:100%;border-radius:7px;object-fit:contain;background:#e7eae4}.visuals figcaption{font-size:12px;padding:12px 5px;color:var(--muted)}.connector-box{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden}.connector-box th:nth-child(1){width:5%}.connector-box th:nth-child(2){width:26%}.connector-box th:nth-child(3){width:14%}.connector-box th:nth-child(4){width:39%}.connector-box th:nth-child(5){width:16%}.connector-box td{font-size:12px}.app-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.mini{background:#fff;border:1px solid var(--line);border-radius:9px;padding:15px}.mini b{display:block;font-size:14px}.mini span{font-size:12px;color:var(--muted)}.empty{display:none;padding:28px;background:#fff;border-radius:10px;text-align:center}.sources{font-size:12px;color:var(--muted)}.sources a{margin-right:15px}footer{padding:30px 0 45px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}.footnotes{font-size:13px}.footnotes ol{padding-left:22px}.footnotes li{margin:10px 0}.noshow{display:none!important}
@media(max-width:850px){.wrap{padding:0 18px}.hero{padding:34px 0}.hero h1{font-size:29px}.stats{grid-template-columns:repeat(2,1fr)}.intro-grid,.trial-grid{grid-template-columns:1fr}.visuals{grid-template-columns:1fr 1fr}.visuals figure:last-child{grid-column:1/-1}.app-grid{grid-template-columns:1fr 1fr}.toolbar{position:relative}.table-wrap table{min-width:790px}.section-head{display:block}.stats .stat:last-child{grid-column:1/-1}}
@media print{body{background:#fff;color:#111;font-size:10pt}.wrap{max-width:none;padding:0}.hero{padding:20px;background:#fff;color:#111}.hero p,.hero .meta,.eyebrow{color:#555}.toolbar,.result-line button,.artifact-links,.action{display:none}.stats{gap:8px}.stat b{font-size:22px}.feature-group{break-inside:auto}.trial,.panel,.stat{break-inside:avoid}.table-wrap{overflow:visible}table{font-size:9pt}.feature-group summary{font-size:12pt}.connector-box td{font-size:8pt}.trial-grid{grid-template-columns:1fr 1fr}th,td{padding:8px}.visuals video{display:none}a{color:#111}section{margin:24px 0}footer{padding:15px 0}}
</style></head><body>
<header class="hero"><div class="wrap"><div class="eyebrow">真实电脑实测 · 功能地图与结果核验</div><h1>WorkBuddy 功能实测清单</h1><p>它能把一句话需求变成文档、图像、视频和可交互网页，也能组织项目和复用专家。部分功能会受连接授权、运行组件和文件读取方式影响。</p><div class="meta">2026年10月1日 · Windows · WorkBuddy 5.6.2 · 本机当前账号与环境</div></div></header>
<main class="wrap">
<div class="stats"><div class="stat"><b>__CORE__</b><span>核心功能与设置条目</span></div><div class="stat"><b>__PASS__</b><span>已完成本次操作验收</span></div><div class="stat"><b>14</b><span>实测场景编号</span></div><div class="stat"><b>204</b><span>已读到的连接器名称</span></div><div class="stat"><b>12</b><span>发现应用入口</span></div></div>
<section><div class="intro-grid"><div class="panel"><h2>已经实际跑通</h2><ul><li><b>办公交付：</b>Excel、Word、PPT、PDF均有真实文件，已打开查看。</li><li><b>视觉创作：</b>插画生成、改杯子颜色、5秒视频生成与播放。</li><li><b>网页小工具：</b>能输入成本和售价，实时算出利润与毛利率。</li><li><b>组织工作：</b>创建项目、待办、拖动看板，创建资料并生成网页。</li><li><b>个人专家：</b>创建、在列表找到、召唤并按三句话规则回答。</li></ul></div><div class="panel"><h2>实际遇到的限制</h2><ul><li><b>附件有曲折：</b>首次报4012；直接路径读取不稳，先在右侧打开文件后读通。</li><li><b>视频比例有偏差：</b>能生成5秒视频，但1344×768不严格等于16:9。</li><li><b>转换没有完成：</b>生成了PDF，未完成要求的Word直接转换。</li><li><b>浏览器能力需补组件：</b>本次通过本机Chrome替代路径完成只读测试。</li><li><b>定时和外部应用：</b>遇到权限或账号前提，未把这些入口算成运行成功。</li></ul></div></div>
<div class="scope"><b>清单范围说明</b><p>这份报告覆盖本次可见的主要页面、菜单、设置及代表性完整工作流程。条目数量是本报告的整理口径，不是官方宣称的功能总数。没有逐个执行所有模型、所有专家、数万市场技能或204个连接器；没有测试真实对外发送、付费购买、多人协作和公开发布。每一项的验证程度都在下面单独标注。</p></div></section>
<section id="artifacts"><h2>直接看这次做出来的东西</h2><p class="muted">全部使用虚构销售和咖啡馆素材。以下是WorkBuddy生成的真实产物，整理时保留原文件内容。</p><div class="artifact-links">__ARTIFACTS__</div><div class="visuals"><figure><img src="__IMG1__" alt="WorkBuddy生成的松鼠咖啡馆原图"><figcaption>生图结果 · __DIM1__ · 桌边杯子为白色</figcaption></figure><figure><img src="__IMG2__" alt="WorkBuddy把杯子修改为蓝色后的结果"><figcaption>局部编辑结果 · __DIM2__ · 桌边杯子改为蓝色</figcaption></figure><figure><video controls preload="metadata" src="__VIDEO__"></video><figcaption>5秒咖啡馆视频 · 实际1344×768<br>点击播放可直接观看。画面比例与要求略有差异。</figcaption></figure></div></section>
<section id="catalog"><div class="section-head"><h2>逐项功能清单</h2><span class="muted">__GROUPS__类 · 每项都有入口和实测结果</span></div><div class="legend"><span>__OK__  本次操作及结果已核验</span><span>__PART__  有结果但存在限制</span><span>__SEEN__  看过界面或配置，没执行到底</span><span>__FAIL__  本次目标未完成</span><span>__UNVERIFIED__  未做实际验收</span></div>
<div class="toolbar"><input id="q" type="search" placeholder="搜索，例如：Excel、定时、微信、生成视频" aria-label="搜索功能"><select id="group" aria-label="选择功能分类"><option value="">全部分类</option>__OPTIONS__</select><select id="status" aria-label="选择验证状态"><option value="">全部状态</option><option>通过</option><option>部分通过</option><option>已查看</option><option>未跑通</option><option>未验证</option></select><button id="reset">清空筛选</button></div><div class="result-line"><span id="matchCount"></span><div><button class="action" id="expand">展开全部</button> <button class="action" id="collapse">收起全部</button> <button class="action" id="print">打印 / 保存PDF</button></div></div><div id="coreSections">__SECTIONS__</div><div id="empty" class="empty">没有找到符合条件的功能。请换一个关键词或清空筛选。</div></section>
<section id="trials"><h2>14组实测记录</h2><p class="muted">同一组可能有多轮追问；05取消、11失败也完整保留在验收记录中，不隐藏失败项。</p><div class="trial-grid">__SCENARIOS__</div></section>
<section id="extensions"><h2>连接器目录：还能接哪些服务</h2><p>连接器可以理解成“把别的服务接给AI使用”。以下用途根据本机市场说明归纳，<b>不是这些服务已经接通或测试成功</b>。一些服务需要自己的账号、额外授权、软件组件或独立付费。</p><p class="muted">读取到204个名称，最后一项说明被截断。市场还可能有后续条目或持续更新，因此这不是永久完整目录。上方搜索框也会筛选此表。</p><details class="connector-box" id="connectorDetails"><summary>展开204个连接器的名称与用途 <span id="extCount"></span></summary><div class="table-wrap"><table><thead><tr><th>编号</th><th>连接器</th><th>用途类别</th><th>主要用途</th><th>本次状态</th></tr></thead><tbody>__EXTROWS__</tbody></table></div></details></section>
<section><h2>“发现应用”中的12个入口</h2><p class="muted">这是应用入口，与上面的连接器目录存在重合；不能把数量直接相加当作独立功能总数。</p><div class="app-grid">__APPS__</div></section>
<section><h2>模型与快捷键速查</h2><div class="intro-grid"><div class="panel"><h3>当时菜单里看到的模型</h3><p>预设：快速、均衡、极致、Max模式。</p><p>模型：Hy4 preview、Hy3、Deepseek-V4.1-Flash、Deepseek-V4-Pro、GLM-5.3、GLM-5.3-Flash、GLM-5.2、GLM-5.1、GLM-5v-Turbo、MiniMax-M3、Kimi-K3、Kimi-K2.8-Preview、Kimi-K2.7-Code、Kimi-K2.6。</p><p class="muted">实际跑过Hy4 preview和快速档。列表来自本次观察，不保证始终可用；倍率、折扣和免费活动以当前菜单为准。</p></div><div class="panel"><h3>日常最实用的操作</h3><p><b>Ctrl+N</b> 新任务　<b>Ctrl+K</b> 全局搜索</p><p><b>Ctrl+,</b> 设置　<b>Ctrl+F</b> 对话内搜索</p><p><b>Ctrl+D</b> 语音输入　<b>Esc</b> 停止生成</p><p><b>Enter</b> 发送　<b>Shift+Enter</b> 换行</p><p><b>Ctrl+B</b> 收起侧栏</p><p class="muted">前三项已实操。其他来自本机快捷键设置页。</p></div></div></section>
<section class="footnotes"><h2>测试后保留了什么</h2><ol><li>独立的测试任务和样例文件。失败的“功能实测11”已经归档；内容专家测试任务改名并置顶。</li><li>测试项目“功能实测1001”，其中“测试项：核对功能清单”位于进行中。</li><li>资料库文档“功能实测资料1001”及其生成网页；个人专家“功能实测三句话助手”；收藏的“学习目标管理台”案例。</li><li>跨磁盘重测使用了C盘的独立测试表副本。浏览器试验提出的临时文件批量清理没有执行。</li><li>深色主题测试后恢复浅色。新任务在测试中改用快速模型，且最近选择的是通俗解释助手；开始正式任务前，可以在输入框底部重新选模型和专家。</li><li>没有新增定时任务、没有公开发布内容、没有新增外部账号授权，也没有购买套餐。部分任务按原设置留下工作记忆，未删除既有记忆。</li></ol></section>
<section class="footnotes"><h2>为什么有些功能止于入口</h2><p>本次电脑操控使用的 <a href="file:///C:/Users/semyi/.codex/plugins/cache/openai-bundled/computer-use/26.915.31029/skills/computer-use/SKILL.md">computer-use 技能</a>要求：<q>Do not act on security or privacy permission requests.</q>（不要代替用户处理安全或隐私授权请求。）因此，定时任务的完全访问确认、应用读取任务授权和外部知识库授权没有代为同意。没有借助其他方式绕过这些确认。</p><p>语音识别缺少真人语音样本；多人协作缺少另一位测试成员；真实发信、交易、发布和删数据会产生外部影响，因此没有为测试执行。若以后需要补测，可根据表里的“部分通过 / 未验证 / 已查看”定位具体事项。</p></section>
<section class="sources"><h2>证据口径与官方对照</h2><p>主要证据：WorkBuddy客户端页面、实际对话、内置预览及生成文件。界面存在仅证明入口存在；AI的完成声明需与可见结果交叉核对。没有独立验证的内部原因，均按“WorkBuddy自述”处理。</p><p>官方资料仅用于确认功能名称和结构，不替代本机实测。<a href="https://www.workbuddy.ai/docs/zh/">官方说明</a><a href="https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Task-Bar">任务栏与工作模式</a><a href="https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Explore">案例与复用说明</a><a href="https://cloud.tencent.com/product/workbuddy">产品页</a></p><p>办公产物另查：PPT __SLIDES__页；工作簿__CHARTS__份图表定义；图像尺寸直接读取文件头。报告不提供各行业专业结论，也不是所有模型的质量评测。</p></section>
</main><footer><div class="wrap">WorkBuddy 功能实测报告 · 2026-10-01 · __CORE__条核心功能与设置 + 204个连接器目录条目。<br>需要做什么：先用搜索框找你关心的功能，再点样例体验；标注授权前提的功能，需要由你本人接入后才能补测。</div></footer>
<script>
const q=document.getElementById('q'), group=document.getElementById('group'), status=document.getElementById('status');
const rows=[...document.querySelectorAll('.feature-row')], blocks=[...document.querySelectorAll('.feature-group')], erows=[...document.querySelectorAll('.ext-row')];
function filter(){const term=q.value.trim().toLocaleLowerCase();let n=0;rows.forEach(r=>{const show=(!term||r.dataset.search.toLocaleLowerCase().includes(term))&&(!group.value||r.dataset.group===group.value)&&(!status.value||r.dataset.status===status.value);r.hidden=!show;if(show)n++});blocks.forEach(d=>{const show=[...d.querySelectorAll('.feature-row')].some(r=>!r.hidden);d.hidden=!show;if(show&&(term||group.value||status.value))d.open=true});document.getElementById('matchCount').textContent=`显示 ${n} / ${rows.length} 条核心功能`;document.getElementById('empty').style.display=n?'none':'block';let x=0;erows.forEach(r=>{const show=!term||r.dataset.search.toLocaleLowerCase().includes(term);r.hidden=!show;if(show)x++});document.getElementById('extCount').textContent=term?` · 匹配 ${x} 条`:'';if(term&&x)document.getElementById('connectorDetails').open=true;}
[q,group,status].forEach(x=>x.addEventListener('input',filter));document.getElementById('reset').onclick=()=>{q.value='';group.value='';status.value='';filter();};document.getElementById('expand').onclick=()=>blocks.forEach(d=>d.open=true);document.getElementById('collapse').onclick=()=>blocks.forEach(d=>d.open=false);document.getElementById('print').onclick=()=>{document.querySelectorAll('details').forEach(d=>d.open=true);window.print();};filter();
</script></body></html>'''
replacements={
'__CORE__':str(len(features)),'__PASS__':str(counts['通过']),'__GROUPS__':str(len(groups)),
'__ARTIFACTS__':artifacts,'__SECTIONS__':''.join(sections),'__SCENARIOS__':scenarios,'__EXTROWS__':extrows,'__APPS__':appcards,
'__OPTIONS__':''.join(f'<option>{e(g)}</option>' for g in groups),
'__OK__':badge('通过'),'__PART__':badge('部分通过'),'__SEEN__':badge('已查看'),'__FAIL__':badge('未跑通'),'__UNVERIFIED__':badge('未验证'),
'__IMG1__':media('松鼠咖啡馆-原图.png','image/png'),'__IMG2__':media('松鼠咖啡馆-改蓝杯.png','image/png'),'__VIDEO__':media('咖啡馆视频.mp4','video/mp4'),
'__DIM1__':'×'.join(map(str,png_dims['松鼠咖啡馆-原图.png'])),'__DIM2__':'×'.join(map(str,png_dims['松鼠咖啡馆-改蓝杯.png'])),
'__SLIDES__':str(slide_count),'__CHARTS__':str(charts)
}
html=html.replace('<section id="catalog">',followup_summary+'<section id="catalog">')
replacements['__TEAM_IMG__']=media('Remove_the_watermark_text_and__2026-10-01T10-01-26.png','image/png')
for key,value in replacements.items(): html=html.replace(key,value)
html=html.replace('5秒', '约5秒').replace('实际1344×768<br>', '实际1344×768，文件时长5.167秒<br>')
html=html.replace('<b>14</b><span>实测场景编号</span>', f'<b>{len(scenario_data)}</b><span>实测场景编号</span>').replace('14组实测记录', f'{len(scenario_data)}组实测记录')
html=html.replace('Windows · WorkBuddy 5.6.2 · 本机当前账号与环境','Windows · WorkBuddy 5.6.2 · 含第二轮补测 · 本机当前账号与环境')
html=html.replace('以下是WorkBuddy生成的真实产物，整理时保留原文件内容。','以下包含WorkBuddy生成的产物，以及在它的内置编辑器中手工修改的补测副本；整理时保留文件内容。')
html=html.replace('实际跑过Hy4 preview和快速档。','快速、均衡、极致三档均已实际调用。快速显示Deepseek-V4.1-Flash，均衡与极致本次都显示Hy4 preview。未做各模型质量跑分。')
html=html.replace('前三项已实操。其他来自本机快捷键设置页。','Ctrl+N、Ctrl+K、Ctrl+,已实操；搜索、停止和收起侧栏还通过按钮完成。其余快捷键来自本机设置页，未逐一按键验收。')
html=html.replace('失败的“功能实测11”已经归档；','“功能实测11”首轮归档后，补测已恢复；')
html=html.replace('其中“测试项：核对功能清单”位于进行中。','其中“测试项：核对功能清单”已完成，优先级为中，保留验收说明及1项已完成的子待办。')
html=html.replace('收藏的“学习目标管理台”案例。','收藏的“学习目标管理台”案例。新增资料夹“功能补测17-资料整理”，含咖啡测试表、公开示例链接和上传的Word副本。')
html=html.replace('且最近选择的是通俗解释助手；开始正式任务前，可以在输入框底部重新选模型和专家。','补测收尾时新任务恢复快速档，输入框没有选中的专家。各历史任务可能保留各自档位，开始正式任务时以输入框当前显示为准。')
html=html.replace('跨磁盘重测使用了C盘的独立测试表副本。','跨磁盘重测使用了C盘的独立测试表副本。补测另保留Word/PPT编辑副本，以及专家团方案和配图。')
html=html.replace('定时任务的完全访问确认、应用读取任务授权和外部知识库授权没有代为同意。','定时任务的完全访问确认、应用读取任务授权和外部知识库授权没有代为同意。第二轮发现定时弹窗有“改为默认权限运行”选项，已请用户本人处理；未收到已操作回复，约定时间过后取消表单。')
out=ROOT/'WorkBuddy功能实测报告.html'
out.write_text(html,encoding='utf-8')
(ROOT/'功能清单数据.json').write_text(json.dumps({'features':features,'extensions':extensions},ensure_ascii=False,indent=2),encoding='utf-8')
with zipfile.ZipFile(ROOT/'WorkBuddy功能报告与实测样例.zip','w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    z.write(out,out.name)
    for p in SAMPLES.iterdir():
        if p.is_file(): z.write(p, 'samples/'+p.name)
    z.write(ROOT/'验收记录.json','验收记录.json')
    if followup_path.exists(): z.write(followup_path,'补测记录.json')
print(json.dumps(qa,ensure_ascii=False,indent=2))
print('report_bytes',out.stat().st_size)
