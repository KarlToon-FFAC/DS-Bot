// Production components/CSS, synthetic authorized identities, no external accounts.
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
const {chromium}=await import(process.env.DSBOT_PLAYWRIGHT_MODULE??'playwright')
const root=resolve(import.meta.dirname,'../..'),harness=join(root,'dev/harness/node_modules')
const output=resolve(process.argv[2]??join(root,'../.dsh-test-tools/history-pagination-ui'));mkdirSync(output,{recursive:true})
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {CommunicationSurface} from '${root}/src/client/communication.js';
import {createSource} from '${root}/src/client/sources.js';import {SHELL_CSS} from '${root}/src/client/styles.js';import {communicationCSS} from '${root}/src/client/communication-styles.js';import {communicationDirectoryCSS} from '${root}/src/client/communication-directory-styles.js';
const style=document.createElement('style');style.textContent=SHELL_CSS+communicationCSS+communicationDirectoryCSS;document.head.append(style);
const self={principalId:'human:a:owner',kind:'human',displayName:'Alice',role:'owner',speakingMode:'speak'},peer={principalId:'human:b:peer',kind:'human',displayName:'Buddy',role:'member',speakingMode:'speak'};
const group={conversationId:'group',title:'History group',kind:'group',role:'owner',speakingMode:'speak',membershipEpoch:'epoch',membershipVersion:1,joinSeq:1,watermark:650,unread:4,info:{ownerPrincipalId:self.principalId,members:[self,peer]}};
const other={...group,conversationId:'other',title:'Other group',membershipEpoch:'other-epoch',watermark:1};
const snapshot={enabled:true,connected:true,reconciled:true,instanceId:'a',hubId:'synthetic',humanPrincipalId:self.principalId,contacts:[self,peer],conversations:[group,other],botConversations:[],archivedConversationIds:[],invites:[],outbox:[],errors:[],localBots:[]};
const event=(id,i,text)=>({type:'message',conversationId:id,conversationSeq:i,eventId:id+'-'+i,serverAcceptedAt:new Date(Date.UTC(2026,10,9,0,0,i)).toISOString(),message:{messageId:id+'-message-'+i,author:peer,content:{text},mentions:[]}});
const histories={group:Array.from({length:650},(_,i)=>event('group',i+1,'Message '+(i+1)+': '+(i%100===99?'needle 中文 historical hit. ':'')+'Reading context. '.repeat(6))),other:[event('other',1,'needle other conversation')]};
const calls=[],held=[];let deferGroup=false;const request=async body=>{calls.push(body);switch(body.endpoint){case 'state':return structuredClone(snapshot);case 'history':{
 if(deferGroup&&body.conversationId==='group')await new Promise(resolve=>held.push(resolve));
 const all=histories[body.conversationId],eligible=all.filter(item=>item.conversationSeq>(body.after??0)&&item.conversationSeq<=(body.before??Infinity));const events=body.latest===false?eligible.slice(0,body.limit):eligible.slice(-body.limit);
 return {conversationId:body.conversationId,membershipEpoch:body.conversationId==='group'?'epoch':'other-epoch',watermark:all.at(-1).conversationSeq,joinSeq:1,events,hasEarlier:events[0]?.conversationSeq>1,hasLater:events.at(-1)?.conversationSeq<all.at(-1).conversationSeq};}
 case 'reference':return histories[body.conversationId].find(item=>item.message.messageId===body.messageId);
 case 'read':snapshot.conversations.find(item=>item.conversationId===body.conversationId).unread=0;return {};
 case 'search-history':{const matches=Object.entries(histories).filter(([id])=>!body.conversationId||body.conversationId===id).flatMap(([id,events])=>events.filter(item=>item.message.content.text.toLowerCase().includes(body.query.toLowerCase())).map(item=>({conversationId:id,membershipEpoch:id==='group'?'epoch':'other-epoch',conversationSeq:item.conversationSeq,messageId:item.message.messageId,author:item.message.author,serverAcceptedAt:item.serverAcceptedAt,excerpt:item.message.content.text}))).sort((a,b)=>b.serverAcceptedAt.localeCompare(a.serverAcceptedAt));const offset=Number(body.cursor??0),results=matches.slice(offset,offset+body.limit);return {results,hasMore:offset+body.limit<matches.length,nextCursor:String(offset+body.limit)}}
 case 'contact-requests':case 'contact-relations':return [];default:return {}}};
const panel=createSource(true),team=createSource({remoteHubEnabled:true,communicationEnabled:true,communicationHubId:'synthetic',ready:true,bots:[]}),surface=createSource({mode:'bot'});
createRoot(document.getElementById('root')).render(React.createElement(CommunicationSurface,{roster:team,surface,panel,request}));
window.fixture={calls,snapshot,histories,held,hold:()=>{deferGroup=true},release:()=>{deferGroup=false;held.splice(0).forEach(resolve=>resolve())},append:()=>{histories.group.push(event('group',651,'Latest new message'));group.watermark=651}};
`
const {outputFiles}=await build({stdin:{contents:entry,resolveDir:root,loader:'js'},bundle:true,platform:'browser',format:'iife',write:false,alias:{react:harness+'/react','react-dom':harness+'/react-dom'},plugins:[{name:'synthetic-platform',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'primitives',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:"import React from 'react';export const FishLogo=()=>null;export const writeClipboard=()=>{};export const MarkdownText=({text})=>React.createElement('p',null,text);",resolveDir:root,loader:'js'}))}}]})
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'application/javascript':'text/html');res.end(req.url==='/app.js'?outputFiles[0].text:'<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script src="/app.js"></script></body></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser
try{
 browser=await chromium.launch({...(process.env.DSBOT_CHROMIUM_PATH?{executablePath:process.env.DSBOT_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']})
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message))
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('[data-conversation-id=group]').click()
 const log=page.locator('.bt-comm-log'),messages=()=>log.locator('article[data-message-id]')
 await page.locator('[data-message-id=group-message-650]').waitFor();assert.equal(await messages().count(),50)
 assert.equal(await messages().first().getAttribute('data-message-id'),'group-message-601')
 assert.equal(await page.evaluate(()=>window.fixture.calls.find(item=>item.endpoint==='history').limit),50)
 await log.evaluate(node=>{node.scrollTop=1})
 const anchor=page.locator('[data-message-id=group-message-601]'),before=(await anchor.boundingBox()).y
 await page.locator('[data-message-id=group-message-551]').waitFor();const after=(await anchor.boundingBox()).y;assert.ok(Math.abs(after-before)<3,'prepending preserves the reading anchor')
 for(const head of [501,451,401,351]){await log.evaluate(node=>{node.scrollTop=1});await page.locator(`[data-message-id=group-message-${head}]`).waitFor();assert.ok(await messages().count()<=200)}
 assert.equal(await messages().count(),200);assert.equal(await page.locator('[data-message-id=group-message-650]').count(),0)
 await log.evaluate(node=>{node.scrollTop=node.scrollHeight})
 const edge=page.locator('[data-message-id=group-message-550]'),edgeTop=(await edge.boundingBox()).y
 await page.locator('[data-message-id=group-message-600]').waitFor()
 assert.ok(Math.abs((await edge.boundingBox()).y-edgeTop)<3,'forward pagination preserves the current reading anchor')
 assert.equal(await messages().count(),200)
 await page.screenshot({animations:'disabled',path:join(output,'progressive-bounded-history-desktop.png')})
 const firstId=await messages().first().getAttribute('data-message-id');await page.evaluate(()=>{window.fixture.append();window.dispatchEvent(new Event('focus'))})
 await page.waitForFunction(()=>window.fixture.calls.filter(item=>item.endpoint==='state').length>2)
 assert.equal(await messages().first().getAttribute('data-message-id'),firstId,'new messages do not replace an older window')
 await page.getByRole('button',{name:'Show latest messages',exact:true}).click();await page.locator('[data-message-id=group-message-651]').waitFor();assert.equal(await messages().count(),50)
 const reads=await page.evaluate(()=>window.fixture.calls.filter(item=>item.endpoint==='read').length)
 await page.getByRole('button',{name:'Search chat history',exact:true}).click()
 const search=page.getByRole('textbox',{name:'Search chat history',exact:true});await search.fill('needle 中文')
 await page.locator('.bt-comm-history-result').first().waitFor();assert.equal(await page.locator('.bt-comm-history-result').count(),6)
 await page.screenshot({animations:'disabled',path:join(output,'canonical-history-search-desktop.png')})
 assert.equal(await page.evaluate(()=>window.fixture.calls.filter(item=>item.endpoint==='read').length),reads,'search does not mark other messages read')
 await page.locator('.bt-comm-history-result').filter({hasText:'Message 600:'}).click()
 const hit=page.locator('[data-message-id=group-message-600]');await hit.waitFor();await page.waitForFunction(()=>document.querySelector('[data-message-id=group-message-600]')?.dataset.referenced==='true')
 assert.equal(await messages().count(),50);assert.ok((await hit.boundingBox()).y>0)
 await page.getByRole('button',{name:'Search chat history',exact:true}).click();await search.fill('Message')
 await page.locator('.bt-comm-history-result').first().waitFor();assert.equal(await page.locator('.bt-comm-history-result').count(),20)
 const result=await page.locator('.bt-comm-history-result').first().innerText()
 await page.getByRole('button',{name:'Next results',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.bt-comm-history-result')?.textContent.includes('Message 631:'))
 assert.equal(await page.locator('.bt-comm-history-result').count(),20)
 await page.getByRole('button',{name:'Previous results',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.bt-comm-history-result')?.textContent.includes('Latest new message')||document.querySelector('.bt-comm-history-result')?.textContent.includes('Message 650:'))
 assert.equal(await page.locator('.bt-comm-history-result').first().innerText(),result)
 await page.getByRole('combobox',{name:'Search scope',exact:true}).selectOption('');await search.fill('needle other')
 await page.locator('.bt-comm-history-result').first().waitFor();await page.locator('.bt-comm-history-result').first().click();await page.locator('[data-message-id=other-message-1]').waitFor()
 assert.equal(await log.locator('[data-message-id^=group]').count(),0)
 await page.evaluate(()=>window.fixture.hold());await page.locator('[data-conversation-id=group]').click();await page.waitForFunction(()=>window.fixture.held.length>0)
 await page.locator('[data-conversation-id=other]').click();await page.locator('[data-message-id=other-message-1]').waitFor();await page.evaluate(()=>window.fixture.release())
 assert.equal(await log.locator('[data-message-id^=group]').count(),0,'late history cannot replace another conversation')
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Search chat history',exact:true}).click();await search.fill('needle')
 await page.locator('.bt-comm-history-result').first().waitFor();await page.screenshot({animations:'disabled',path:join(output,'history-search-mobile.png')})
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[])
 console.log('PASS 650-message latest page, upward pagination/anchor, 200-event cap, live arrival stability, search/page/jump, stale read fence and mobile layout; zero browser errors')
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
