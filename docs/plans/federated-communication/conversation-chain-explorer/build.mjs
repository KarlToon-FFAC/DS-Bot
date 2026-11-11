import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const input = new URL('./scenarios.json', import.meta.url);
const output = new URL('./index.html', import.meta.url);
const data = JSON.parse(await readFile(input, 'utf8'));
if (data.status !== 'design_walkthrough' || !Array.isArray(data.scenarios)) {
  throw new Error('Expected design_walkthrough scenario data');
}
const scenarioIds = new Set();
for (const scenario of data.scenarios) {
  if (scenarioIds.has(scenario.id)) throw new Error('Duplicate scenario: ' + scenario.id);
  scenarioIds.add(scenario.id);
  const nodes = new Map();
  const positions = new Set();
  for (const node of scenario.nodes) {
    const position = JSON.stringify([node.actor, node.step]);
    if (nodes.has(node.id) || positions.has(position)) throw new Error('Duplicate node or position: ' + scenario.id + '/' + node.id);
    if (!scenario.actors.includes(node.actor) || !Number.isInteger(node.step) || node.step < 1) throw new Error('Invalid actor/step: ' + node.id);
    if (!['message', 'run', 'decision', 'draft', 'join', 'control'].includes(node.kind)) throw new Error('Invalid node kind: ' + node.id);
    if (!['group', 'local', 'status'].includes(node.visibility)) throw new Error('Invalid node visibility: ' + node.id);
    nodes.set(node.id, node);
    positions.add(position);
  }
  for (const edge of scenario.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to || from.step >= to.step) throw new Error('Invalid causal edge: ' + scenario.id + '/' + edge.from + ' -> ' + edge.to);
    if (!['activate', 'reference', 'result', 'control'].includes(edge.type)) throw new Error('Invalid edge type: ' + edge.type);
  }
}
const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const html = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>群聊对话链 · 情景推演</title>
<style>
:root{color-scheme:light;--ink:#18293d;--muted:#52667c;--line:#d8e2ec;--blue:#225ac5;--green:#08715f;--orange:#a55010;--paper:#fff;--bg:#eef3f8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}button,input{font:inherit}button{cursor:pointer}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #0b71d5;outline-offset:3px}button:disabled{opacity:.45;cursor:default}header{background:#162a43;color:white;padding:25px 32px 24px}header .eyebrow{font-size:12px;letter-spacing:2px;color:#a4c6f5}h1{margin:5px 0 7px;font-size:28px;line-height:1.3}header p{margin:0;max-width:960px;color:#d7e4f5;font-size:14px}.warning{display:inline-block;margin-top:14px;border:1px solid #728aa6;border-radius:6px;padding:4px 9px;color:#fce1a0;font-size:12px}main{padding:22px 28px;max-width:1800px;margin:auto}.scenarios{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-bottom:20px}.scenario{padding:10px 12px;text-align:left;border:1px solid var(--line);border-radius:9px;background:white;color:var(--muted);min-height:63px;font-size:13px;line-height:1.45}.scenario .num{font-weight:700;color:#72849a;margin-right:7px}.scenario[aria-current=true]{border-color:var(--blue);box-shadow:0 0 0 1px var(--blue);color:var(--blue);background:#f2f7ff}.intro{display:grid;grid-template-columns:1fr auto;gap:20px;align-items:start;margin-bottom:14px}h2{font-size:22px;line-height:1.4;margin:0 0 6px}.summary{color:var(--muted);margin:0;max-width:1000px}.question{font-weight:650;margin:0 0 5px}.pill{display:inline-block;border:1px solid #c3d4e6;background:#e5edf8;color:#25476c;border-radius:30px;padding:4px 11px;font-size:12px;white-space:nowrap}.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:12px 15px;background:white;border:1px solid var(--line);border-radius:10px 10px 0 0}.toolbar button{border:1px solid #c9d6e4;background:#f8fafc;color:var(--ink);border-radius:6px;padding:6px 11px;white-space:nowrap}.toolbar button.primary{background:var(--blue);border-color:var(--blue);color:white}.range-wrap{display:flex;align-items:center;gap:10px;flex:1;min-width:210px}.range-wrap input{width:100%;accent-color:var(--blue)}.step-label{font-variant-numeric:tabular-nums;min-width:65px;font-size:13px;color:var(--muted)}.toggle{display:flex;align-items:center;gap:6px;white-space:nowrap;font-size:13px}.toggle input{accent-color:var(--blue);width:17px;height:17px}.legend{display:flex;align-items:center;gap:18px;flex-wrap:wrap;background:#f8fafc;border:1px solid var(--line);border-top:0;padding:9px 15px;font-size:12px;color:var(--muted)}.legend span{display:flex;align-items:center;gap:7px}.line{display:inline-block;width:26px;border-top:2px solid var(--blue)}.line.result{border-color:var(--green)}.line.reference{border-color:#8290a0;border-top-style:dashed}.line.control{border-color:var(--orange);border-top-style:dashed}.layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:15px;margin-top:15px}.graph-shell{min-width:0;background:white;border:1px solid var(--line);border-radius:10px;overflow:hidden}.graph-top{padding:10px 15px;border-bottom:1px solid var(--line);display:flex;gap:15px;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted)}#graph-scroll{overflow:auto;max-height:72vh;min-height:380px;scrollbar-gutter:stable}#graph{display:block;max-width:none}aside{display:flex;flex-direction:column;gap:13px;min-width:0}.panel{background:white;border:1px solid var(--line);border-radius:10px;padding:16px}.panel h3{font-size:14px;margin:0 0 8px}.panel p{margin:6px 0;font-size:13px;overflow-wrap:anywhere}.panel ul{margin:5px 0 0;padding-left:18px;font-size:13px}.panel li+li{margin-top:6px}.hint{color:var(--muted)}#detail.empty{border-style:dashed;background:#f7f9fc}.meta{display:flex;flex-wrap:wrap;gap:5px;margin:10px 0}.tag{display:inline-block;border-radius:4px;background:#edf2f7;padding:2px 6px;font-size:11px;color:#50647b}.outcome{border-left:3px solid var(--green)}.limit{border-left:3px solid var(--orange)}.footer{color:var(--muted);font-size:12px;margin:17px 1px 0}.stat strong{color:var(--ink);font-weight:700}.edge{fill:none;stroke-width:1.8;opacity:.66}.edge.dim{opacity:.12}.edge.focus{stroke-width:2.7;opacity:1}.node{cursor:pointer;outline:none}.node .card{stroke-width:1.2;filter:drop-shadow(0 2px 2px #1729430b)}.node:hover .card,.node:focus .card{stroke:#285ed0;stroke-width:2.3}.node.selected .card{stroke:#174aa8;stroke-width:3}.node.dim{opacity:.36}.node-title{font-size:13px;font-weight:650;fill:#1c3048}.node-sub{font-size:10px;fill:#556a7f}.node-badge{font-size:10px;font-weight:650}.lane-label{font-size:13px;font-weight:650;fill:#30475f}.step-number{font-size:11px;fill:#6d8094}.edge-label{font-size:10px;fill:#53697f;paint-order:stroke;stroke:white;stroke-width:5px;stroke-linejoin:round}.private-banner{font-size:11px;fill:#758293}.empty-note{font-size:14px;fill:#60748a}
@media(max-width:1100px){.scenarios{grid-template-columns:repeat(3,minmax(0,1fr))}.layout{grid-template-columns:minmax(0,1fr) 265px}main{padding:18px}header{padding:24px}.intro{grid-template-columns:1fr}.intro .pill{display:none}}
@media(max-width:760px){header{padding:19px 16px}h1{font-size:23px}main{padding:14px 10px}.scenarios{grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.scenario{min-height:58px;padding:8px;font-size:12px}.layout{grid-template-columns:1fr}aside{display:grid;grid-template-columns:1fr}h2{font-size:19px}.toolbar{gap:8px;padding:10px}.range-wrap{order:3;flex-basis:100%}.toggle{margin-left:auto}.graph-top{gap:7px;flex-wrap:wrap}#graph-scroll{max-height:65vh;min-height:300px}.legend{gap:8px 13px}.panel{padding:13px}}
</style>
</head>
<body>
<header><div class="eyebrow">DS BOT / CONVERSATION GRAPH</div><h1>一条对话，怎样长出分支？</h1><p>节点是消息或处理事件，列是参与者。同一个 Bot 可以在链上反复出现；引用一条消息，不等于再次唤醒它的作者。</p><div class="warning">设计情景推演 · 非当前版本运行实测 · 未连接模型、客户端或 Hub</div></header>
<main>
<nav id="scenarios" class="scenarios" aria-label="选择工况"></nav>
<section class="intro"><div><h2 id="title"></h2><p id="question" class="question"></p><p id="summary" class="summary"></p></div><span class="pill">消息图 / 任务关系 / 调度分离</span></section>
<div class="toolbar"><button id="prev" title="上一步">← 上一步</button><button id="next" class="primary">下一步 →</button><button id="play">播放</button><button id="all">完整图</button><button id="fit">适配宽度</button><div class="range-wrap"><input id="step" type="range" min="0" value="0" aria-label="推演步骤"><span id="step-label" class="step-label"></span></div><label class="toggle"><input id="public-only" type="checkbox">只看群消息</label></div>
<div class="legend"><span><i class="line"></i>授权处理 / 建任务</span><span><i class="line result"></i>结果 / 依赖汇合</span><span><i class="line reference"></i>引用 / 关联（不唤醒）</span><span><i class="line control"></i>控制 / 提交（不等于新任务）</span></div>
<div class="layout"><section class="graph-shell" aria-label="对话链可视化"><div class="graph-top"><span id="stats" class="stat"></span><span id="view-note">方案视图含本地私密与控制事件；这些不是群消息。</span></div><div id="graph-scroll"><svg id="graph" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="对话事件因果图"></svg></div></section><aside><section id="detail" class="panel empty" aria-live="polite"></section><section class="panel outcome"><h3>这一工况的结果</h3><p id="outcome"></p></section><section class="panel"><h3>必须遵守的规则</h3><ul id="rules"></ul></section><section class="panel limit"><h3>支持边界</h3><ul id="limits"></ul></section></aside></div>
<p class="footer">阅读方式：从上往下看时间，从左往右看参与者。不同列的同一步可以并行；箭头表示因果或关联，不表示消息自动复制。点击节点查看所属对话链、任务和可见范围。此页为固定脚本的分步推演，仅用于评审设计，不是现有协议的实现或系统测试。</p>
</main>
<script type="application/json" id="scenario-data">__SCENARIO_DATA__</script>
<script>
'use strict';
const data=JSON.parse(document.getElementById('scenario-data').textContent);
const $=id=>document.getElementById(id);
const ns='http://www.w3.org/2000/svg';
const edgeColors={activate:'#225ac5',result:'#08715f',reference:'#8290a0',control:'#a55010'};
const kindNames={message:'消息',run:'运行',decision:'明确决定',draft:'私密草稿',join:'依赖汇合',control:'控制事件'};
let index=0,step=0,selected=null,timer=null,fit=false;
const current=()=>data.scenarios[index];
const maxStep=()=>Math.max(...current().nodes.map(n=>n.step));
function element(tag,attrs,text){const e=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs||{}))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e;}
function htmlElement(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function stop(){if(timer)clearInterval(timer);timer=null;$('play').textContent='播放';}
function list(id,values){$(id).replaceChildren(...values.map(v=>htmlElement('li','',v)));}
function selectScenario(i){stop();index=i;step=maxStep();selected=null;$('title').textContent=String(i+1).padStart(2,'0')+' / '+current().title;$('question').textContent=current().question;$('summary').textContent=current().summary;$('outcome').textContent=current().outcome;list('rules',current().rules);list('limits',current().limits);$('step').max=maxStep();document.querySelectorAll('.scenario').forEach((b,j)=>b.setAttribute('aria-current',String(i===j)));render();$('graph-scroll').scrollTo({top:0,left:0});}
function selectNode(id){selected=id;render();}
function split(text,size){return Array.from(String(text)).reduce((rows,ch,i)=>{const j=Math.floor(i/size);rows[j]=(rows[j]||'')+ch;return rows;},[]);}
function drawDetail(){const panel=$('detail');panel.replaceChildren();const node=current().nodes.find(n=>n.id===selected);panel.classList.toggle('empty',!node);if(!node){panel.append(htmlElement('h3','','点击一个节点'),htmlElement('p','hint','查看它为什么发生、属于哪条链、是否会唤醒其他 Bot。灰色私密节点只为解释方案，不能出现在群成员的消息图中。'));return;}panel.append(htmlElement('h3','',node.actor+' · '+kindNames[node.kind]),htmlElement('p','',node.text));const meta=htmlElement('div','meta');for(const v of ['步骤 '+node.step,node.chain||'无对话链',node.task||'无任务',node.visibility==='group'?'群可见':node.visibility==='local'?'仅本地执行记录':'控制状态 / 按权限可见'])meta.append(htmlElement('span','tag',v));panel.append(meta,htmlElement('p','',node.detail));const incoming=current().edges.filter(e=>e.to===node.id);const outgoing=current().edges.filter(e=>e.from===node.id);panel.append(htmlElement('p','hint','关联：'+incoming.length+' 条入边 / '+outgoing.length+' 条出边。图中的运行和控制事件不等同于一条公开聊天消息。'));}
function render(){const s=current();const publicOnly=$('public-only').checked;const visible=s.nodes.filter(n=>n.step<=step&&(!publicOnly||n.visibility==='group'));const ids=new Set(visible.map(n=>n.id));if(selected&&!ids.has(selected))selected=null;const edges=s.edges.filter(e=>ids.has(e.from)&&ids.has(e.to));const selectedEdges=edges.filter(e=>e.from===selected||e.to===selected);const adjacent=new Set(selectedEdges.flatMap(e=>[e.from,e.to]));if(selected)adjacent.add(selected);const lane=246,left=72,top=66,row=118,cardW=214,cardH=82;const width=left+s.actors.length*lane+24;const height=top+Math.max(3,maxStep())*row+24;const svg=$('graph');svg.replaceChildren();svg.setAttribute('width',width);svg.setAttribute('height',height);svg.setAttribute('viewBox','0 0 '+width+' '+height);svg.style.width=fit?'100%':'';svg.style.height=fit?'auto':'';const defs=element('defs');for(const [type,color]of Object.entries(edgeColors)){const marker=element('marker',{id:'arrow-'+type,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'});marker.append(element('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:color}));defs.append(marker);}svg.append(defs);
for(let i=0;i<s.actors.length;i++){const x=left+i*lane;svg.append(element('rect',{x,y:0,width:lane,height,fill:i%2?'#f7f9fc':'#fff'}));svg.append(element('line',{x1:x,y1:45,x2:x,y2:height,stroke:'#e8edf3'}));svg.append(element('text',{x:x+lane/2,y:30,'text-anchor':'middle',class:'lane-label'},s.actors[i]));}
for(let n=1;n<=maxStep();n++){const y=top+(n-1)*row;svg.append(element('text',{x:34,y:y+17,'text-anchor':'middle',class:'step-number'},String(n).padStart(2,'0')));svg.append(element('line',{x1:left,y1:y-12,x2:width-24,y2:y-12,stroke:'#edf1f6','stroke-dasharray':'3 5'}));}
const positions=new Map(visible.map(n=>[n.id,{x:left+s.actors.indexOf(n.actor)*lane+(lane-cardW)/2,y:top+(n.step-1)*row}]));
for(const edge of edges){const a=positions.get(edge.from),b=positions.get(edge.to);const x1=a.x+cardW/2,y1=a.y+cardH,x2=b.x+cardW/2,y2=b.y;const gap=Math.min(36,Math.max(17,(y2-y1)/2));const longEdge=y2-y1>row;const gutter=a.x+cardW+9;const path=longEdge?'M '+x1+' '+y1+' V '+(y1+12)+' H '+gutter+' V '+(y2-14)+' H '+x2+' V '+y2:x1===x2?'M '+x1+' '+y1+' L '+x2+' '+y2:'M '+x1+' '+y1+' C '+x1+' '+(y1+gap)+' '+x2+' '+(y2-gap)+' '+x2+' '+y2;const cls='edge'+(selected?(adjacent.has(edge.from)&&adjacent.has(edge.to)?' focus':' dim'):'');svg.append(element('path',{d:path,stroke:edgeColors[edge.type],class:cls,'stroke-dasharray':edge.type==='reference'?'5 4':edge.type==='control'?'3 3':'none','marker-end':'url(#arrow-'+edge.type+')'}));if(edge.label&&(!selected||edge.from===selected||edge.to===selected)){const labelX=longEdge?(gutter+x2)/2:x1===x2?x1+8:(x1+x2)/2;const labelY=longEdge?y2-18:(y1+y2)/2-3;svg.append(element('text',{x:labelX,y:labelY,'text-anchor':!longEdge&&x1===x2?'start':'middle',class:'edge-label'},edge.label));}}
for(const node of visible){const p=positions.get(node.id);const privateNode=node.visibility==='local';const isResult=node.kind==='join'||(node.kind==='message'&&s.edges.some(e=>e.from===node.id&&e.type==='result'));const colors=privateNode?['#f1f3f6','#b7c3cf','#65758a']:node.kind==='control'||node.kind==='decision'?['#fff5e8','#e4bf8c','#995317']:isResult?['#eaf8f2','#94cebb','#086b55']:['#eef5ff','#a9c4eb','#2457a2'];const g=element('g',{class:'node'+(node.id===selected?' selected':selected&&!adjacent.has(node.id)?' dim':''),tabindex:0,role:'button','aria-label':node.actor+'，步骤 '+node.step+'，'+node.text});g.append(element('rect',{x:p.x,y:p.y,width:cardW,height:cardH,rx:9,fill:colors[0],stroke:colors[1],class:'card'}));g.append(element('text',{x:p.x+12,y:p.y+17,class:'node-badge',fill:colors[2]},kindNames[node.kind]+' · '+(node.visibility==='group'?'群可见':privateNode?'本地私密':'控制状态')));const lines=split(node.text,16).slice(0,2);lines.forEach((line,i)=>g.append(element('text',{x:p.x+12,y:p.y+37+i*17,class:'node-title'},line)));g.append(element('text',{x:p.x+12,y:p.y+71,class:'node-sub'},[node.chain,node.task].filter(Boolean).join(' · ')));g.addEventListener('click',()=>selectNode(node.id));g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectNode(node.id);}});svg.append(g);}
if(!visible.length)svg.append(element('text',{x:left+22,y:top+38,class:'empty-note'},step===0?'尚未开始，点击“下一步”观察对话如何展开。':'当前步骤没有群可见消息。'));
$('step').value=step;$('step-label').textContent=step+' / '+maxStep();$('prev').disabled=step===0;$('next').disabled=step===maxStep();const messages=visible.filter(n=>n.visibility==='group').length;const runs=visible.filter(n=>n.kind==='run').length;$('stats').replaceChildren(htmlElement('span','','已展示 '+visible.length+' 个事件 · '+messages+' 条群消息 · '+runs+' 个运行节点'));$('view-note').textContent=publicOnly?'虚构方案筛选；真实群接口不得包含私密节点。隐藏节点不补成唤醒边。':'方案视图含本地私密与控制事件；这些不是群消息。';drawDetail();}
function advance(n,scroll){step=Math.max(0,Math.min(maxStep(),n));render();if(scroll&&step>0)$('graph-scroll').scrollTo({top:Math.max(0,(66+(step-1)*118)*($('graph').getBoundingClientRect().width/Number($('graph').getAttribute('width')))-190),behavior:'smooth'});}
data.scenarios.forEach((s,i)=>{const b=htmlElement('button','scenario');b.append(htmlElement('span','num',String(i+1).padStart(2,'0')),document.createTextNode(s.title));b.addEventListener('click',()=>selectScenario(i));$('scenarios').append(b);});
$('fit').addEventListener('click',()=>{fit=!fit;$('fit').textContent=fit?'原尺寸':'适配宽度';render();});
$('prev').addEventListener('click',()=>{stop();advance(step-1,true);});$('next').addEventListener('click',()=>{stop();advance(step+1,true);});$('all').addEventListener('click',()=>{stop();advance(maxStep(),false);$('graph-scroll').scrollTo({top:0});});$('step').addEventListener('input',()=>{stop();advance(Number($('step').value),true);});$('public-only').addEventListener('change',render);$('play').addEventListener('click',()=>{if(timer){stop();return;}if(step===maxStep())advance(0,false);$('play').textContent='暂停';timer=setInterval(()=>{advance(step+1,true);if(step===maxStep())stop();},1000);});
selectScenario(0);
</script>
</body>
</html>
`.replace('__SCENARIO_DATA__', json);
if (process.argv.includes('--check')) {
  const existing = await readFile(output, 'utf8');
  if (existing !== html) throw new Error('index.html is stale; run node build.mjs');
  console.log('Conversation-chain visualization is up to date.');
} else {
  await writeFile(output, html);
  console.log('Wrote ' + fileURLToPath(output));
}
