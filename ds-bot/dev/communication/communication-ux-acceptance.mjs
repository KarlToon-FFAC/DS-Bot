// Production components/CSS, synthetic authorized identities, no external accounts.
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
const {chromium}=await import(process.env.DSBOT_PLAYWRIGHT_MODULE??'playwright')
const root=resolve(import.meta.dirname,'../..'),harness=join(root,'dev/harness/node_modules')
const output=resolve(process.argv[2]??join(root,'../.dsh-test-tools/communication-ux-ui'));mkdirSync(output,{recursive:true})
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {CommunicationSurface} from '${root}/src/client/communication.js';import {TeamSidebar,SIDEBAR_CSS} from '${root}/src/client/sidebar.js';
import {createSource} from '${root}/src/client/sources.js';import {SHELL_CSS} from '${root}/src/client/styles.js';import {communicationCSS} from '${root}/src/client/communication-styles.js';import {communicationDirectoryCSS} from '${root}/src/client/communication-directory-styles.js';
const style=document.createElement('style');style.textContent=SHELL_CSS+SIDEBAR_CSS+communicationCSS+communicationDirectoryCSS;document.head.append(style);
const self={principalId:'human:a:owner',kind:'human',displayName:'Alice',role:'owner',speakingMode:'speak'},buddy={principalId:'human:b:buddy',kind:'human',displayName:'Buddy',role:'member',speakingMode:'speak'},bot={principalId:'bot:b:tester',kind:'bot',displayName:'Tester',ownerPrincipalId:buddy.principalId,role:'member',speakingMode:'active'};
const profile={version:1,headline:'Testing specialist',summary:'Background in reproducing failures and checking fixes.',expertise:['Regression testing','Shell testing']};
const group={conversationId:'group',title:'Review group',kind:'group',role:'owner',speakingMode:'speak',membershipEpoch:'epoch',membershipVersion:1,joinSeq:1,watermark:40,unread:4,info:{title:'Review group',membershipVersion:1,ownerPrincipalId:self.principalId,members:[self,buddy,bot],routing:{mode:'mentions'},policies:{}}};
const dm={...group,conversationId:'dm',kind:'dm',title:'Buddy DM',unread:1,watermark:0,info:{members:[self,buddy]}};
const snapshot={enabled:true,connected:true,reconciled:true,instanceId:'a',hubId:'synthetic',humanPrincipalId:self.principalId,contacts:[self,buddy,bot],conversations:[group,dm],botConversations:[],archivedConversationIds:[],invites:[],outbox:[],errors:[],localBots:[],managementRevision:1};
const events=Array.from({length:40},(_,i)=>({type:'message',conversationId:'group',conversationSeq:i+1,serverAcceptedAt:'2026-11-09T00:00:00Z',message:{messageId:'m'+i,author:i===0?self:bot,content:{text:i===0?'Original review request':'Reply '+i+': '+('Readable testing context. '.repeat(12))},mentions:[],replyToMessageId:i?'m0':null}}));
const calls=[];const request=async body=>{calls.push(body);switch(body.endpoint){case 'state':return structuredClone(snapshot);case 'history':return {conversationId:body.conversationId,membershipEpoch:'epoch',watermark:40,events:body.conversationId==='group'?events:[]};case 'thread':return {conversationId:'group',membershipEpoch:'epoch',messageId:body.messageId,rootMessageId:'m0',watermark:40,events,hasMore:false};case 'reference':return events.find(event=>event.message.messageId===body.messageId);case 'read':snapshot.conversations.find(item=>item.conversationId===body.conversationId).unread=0;return {};case 'human-profile-info':return {principalId:self.principalId,publicProfile:{version:1}};case 'participant-profile':return {principalId:body.targetPrincipalId,publicProfile:profile};case 'user-code':return {userCode:'synthetic-user-code'};case 'available-bots':return {bots:[],publishedBotIds:[]};case 'work-approval-settings':return {remoteWorkApproval:'inherit'};case 'memory-settings':return {localMemory:false};case 'contact-requests':case 'contact-relations':return [];default:return {}}};
const panel=createSource(true),team=createSource({remoteHubEnabled:true,communicationEnabled:true,communicationHubId:'synthetic',ready:true,bots:[]}),surface=createSource({mode:'bot'}),reactRoot=createRoot(document.getElementById('root'));
const remote=()=>{panel.set(true);reactRoot.render(React.createElement(CommunicationSurface,{roster:team,surface,panel,request}))};
const local=()=>{panel.set(false);const roster={remoteHubEnabled:true,remoteUnreadCount:snapshot.conversations.reduce((sum,item)=>sum+item.unread,0),ready:true,bots:[],rooms:[],agents:[],byId:{}};reactRoot.render(React.createElement(TeamSidebar,{wide:true,useRoster:pick=>pick(roster),useUi:pick=>pick({unread:{},leftDrawer:innerWidth<1024}),useRegistry:pick=>pick({}),useSessions:pick=>pick({ids:[],byId:{}}),useUpdate:()=>({}),useSidebarPref:pick=>pick('open'),actions:{openCommunication:remote,openPalette(){},openNewChat(){}}}))};
window.fixture={snapshot,events,calls,remote,local};local();`
const {outputFiles}=await build({stdin:{contents:entry,resolveDir:root,loader:'js'},bundle:true,platform:'browser',format:'iife',write:false,alias:{react:harness+'/react','react-dom':harness+'/react-dom'},plugins:[{name:'synthetic-platform',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'primitives',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:"import React from 'react';export const FishLogo=()=>null;export const writeClipboard=()=>{};export const MarkdownText=({text})=>React.createElement('p',null,text);",resolveDir:root,loader:'js'}))}}]})
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'application/javascript':'text/html');res.end(req.url==='/app.js'?outputFiles[0].text:'<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script src="/app.js"></script></body></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser
try{
 browser=await chromium.launch({...(process.env.DSBOT_CHROMIUM_PATH?{executablePath:process.env.DSBOT_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']})
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}`)
 await page.getByRole('button',{name:'Remote communication, 5 unread messages',exact:true}).waitFor()
 assert.equal(await page.locator('.bt-remote-unread').innerText(),'5')
 await page.locator('.bt-remote-entry').click();await page.locator('[data-conversation-id=group]').waitFor()
 assert.equal(await page.locator('[data-conversation-id=group] .bt-comm-unread').innerText(),'4')
 await page.getByRole('button',{name:'Personal settings',exact:true}).click()
 const sections=page.locator('.bt-comm-personal-settings .bt-comm-profile-section');assert.equal(await sections.count(),7)
 assert.equal(await sections.evaluateAll(nodes=>nodes.filter(node=>node.open).length),0)
 await page.screenshot({animations:'disabled',path:join(output,'personal-settings-collapsed-desktop.png')})
 const own=sections.filter({has:page.locator(':scope>summary',{hasText:'Your profile'})})
 await own.locator(':scope>summary').click();await page.getByRole('textbox',{name:'Human name',exact:true}).fill('Uncommitted Alice')
 await own.locator(':scope>summary').click();await own.locator(':scope>summary').click();assert.equal(await page.getByRole('textbox',{name:'Human name',exact:true}).inputValue(),'Uncommitted Alice')
 await page.getByRole('button',{name:'Close dialog',exact:true}).click()
 await page.locator('[data-conversation-id=group]').click();await page.waitForFunction(()=>window.fixture.calls.some(item=>item.endpoint==='read'&&item.seq===40))
 await page.waitForFunction(()=>!document.querySelector('[data-conversation-id=group] .bt-comm-unread'))
 async function drag(side,delta){const handle=page.getByRole('separator',{name:side==='left'?'Resize conversation sidebar':'Resize group information sidebar',exact:true});const box=await handle.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+100);await page.mouse.down();await page.mouse.move(box.x+box.width/2+delta,box.y+100,{steps:6});await page.mouse.up()}
 const left=page.locator('.bt-comm-nav'),before=(await left.boundingBox()).width;await drag('left',80);const after=(await left.boundingBox()).width;assert.ok(after>before+60)
 await page.getByRole('separator',{name:'Resize conversation sidebar',exact:true}).focus();await page.keyboard.press('ArrowLeft');assert.ok((await left.boundingBox()).width<after)
 const leftWidth=(await left.boundingBox()).width
 await page.locator('.bt-comm-title-pill').click();const right=page.locator('.bt-comm-members[open]');const rightBefore=(await right.boundingBox()).width
 await page.getByRole('textbox',{name:'Group name',exact:true}).fill('Unsaved group draft')
 await drag('right',-80);assert.ok((await right.boundingBox()).width>rightBefore+60);assert.equal(await page.getByRole('textbox',{name:'Group name',exact:true}).inputValue(),'Unsaved group draft')
 const rightWidth=(await right.boundingBox()).width
 await page.screenshot({animations:'disabled',path:join(output,'resized-sidebars-desktop.png')})
 await page.reload();await page.locator('.bt-remote-entry').click();await page.locator('[data-conversation-id=group]').click();assert.ok(Math.abs((await left.boundingBox()).width-leftWidth)<2)
 await page.locator('.bt-comm-title-pill').click();assert.ok(Math.abs((await right.boundingBox()).width-rightWidth)<2)
 await page.getByRole('button',{name:'Close member settings',exact:true}).first().click()
 const avatar=page.locator('article[data-message-id=m39] .bt-comm-avatar-button');await avatar.click()
 const info=page.getByRole('dialog',{name:'Participant information',exact:true});await info.waitFor();await info.getByText('Regression testing',{exact:true}).waitFor();assert.ok((await info.innerText()).includes('Buddy'))
 await page.screenshot({animations:'disabled',path:join(output,'message-avatar-profile.png')})
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();assert.ok(await avatar.evaluate(node=>node===document.activeElement))
 await page.locator('article[data-message-id=m39] button[aria-label="Reply"]').click()
 const popup=page.getByRole('dialog',{name:'Message replies',exact:true});await popup.waitFor();const pop=await popup.boundingBox();assert.ok(pop.width>=850&&pop.height>=760)
 assert.ok(await popup.getByRole('textbox',{name:'Reply in this thread',exact:true}).isVisible())
 await page.screenshot({animations:'disabled',path:join(output,'larger-reply-chain-desktop.png')})
 await page.getByRole('button',{name:'Close replies',exact:true}).click()
 await page.setViewportSize({width:390,height:844})
 await page.locator('.bt-comm-title-pill').click();assert.equal(await page.getByRole('separator',{name:'Resize group information sidebar',exact:true}).isVisible(),false)
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
 await page.getByRole('button',{name:'Close member settings',exact:true}).first().click()
 await page.locator('article[data-message-id=m39] button[aria-label="Reply"]').click();await popup.waitFor();const small=await popup.boundingBox();assert.ok(small.x>=0&&small.x+small.width<=390&&small.y+small.height<=844)
 await page.screenshot({animations:'disabled',path:join(output,'larger-reply-chain-mobile.png')})
 await page.getByRole('button',{name:'Close replies',exact:true}).click();await page.getByRole('button',{name:'Conversations',exact:true}).click()
 await page.getByRole('button',{name:'Personal settings',exact:true}).click();assert.equal(await sections.count(),7)
 await page.screenshot({animations:'disabled',path:join(output,'personal-settings-collapsed-mobile.png')})
 assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>window.fixture.calls.some(item=>['send','profile-human','profile-human-info','save-settings'].includes(item.endpoint))),false)
 console.log('PASS unread badges; independent profile folds/drafts; pointer/keyboard sidebar resizing and persistence; avatar profile/focus; larger desktop/mobile replies; zero browser errors or writes')
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
