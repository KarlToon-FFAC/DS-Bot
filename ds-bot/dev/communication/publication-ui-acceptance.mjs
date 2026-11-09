// Synthetic fixtures; real production components and Chromium layout. No DSH data or keys.
import {build} from 'esbuild'
import {resolve,join} from 'node:path'
import {mkdirSync} from 'node:fs'
const {chromium}=await import(process.env.DSBOT_PLAYWRIGHT_MODULE ?? 'playwright')
import {createServer} from 'node:http'
import assert from 'node:assert/strict'
const root=resolve(import.meta.dirname,'../..'), client=root+'/src/client', harness=root+'/dev/harness/node_modules'
const output=resolve(process.argv[2] ?? join(root,'../.dsh-test-tools/publication-ui'));mkdirSync(output,{recursive:true})
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {communicationMentions} from '${root}/src/shared/communication-mentions.js';
import {CommunicationSurface} from '${client}/communication.js';import {createSource} from '${client}/sources.js';
import {SHELL_CSS} from '${client}/styles.js';import {BOT_SETTINGS_CSS} from '${client}/bot-settings.js';import {communicationCSS} from '${client}/communication-styles.js';import {communicationDirectoryCSS} from '${client}/communication-directory-styles.js';
const css=document.createElement('style');css.textContent=SHELL_CSS+BOT_SETTINGS_CSS+communicationCSS+communicationDirectoryCSS;document.head.append(css);
const self={principalId:'human:a:owner',displayName:'Alice',kind:'human',homeInstanceId:'a',ipAddress:'192.0.2.10'};
const buddy={principalId:'human:b:buddy',displayName:'Buddy',kind:'human',homeInstanceId:'b',ipAddress:'192.0.2.20'};
const local={principalId:'bot:a:local',displayName:'Local tester',kind:'bot',homeInstanceId:'a',ownerPrincipalId:self.principalId};
const bots=['贝塔','API tester'].map((name,index)=>({principalId:'bot:b:bot'+index,displayName:name,kind:'bot',homeInstanceId:'b',ownerPrincipalId:buddy.principalId}));
const membership={conversationId:'group',title:'Empty review',kind:'group',role:'owner',speakingMode:'speak',membershipEpoch:'epoch',membershipVersion:1,ownerPrincipalId:self.principalId,watermark:0,info:{members:[{...self,role:'owner',speakingMode:'speak'},{...local,role:'member',speakingMode:'passive'},{...buddy,role:'member',speakingMode:'readOnly'},...bots.map(bot=>({...bot,role:'member',speakingMode:'passive'}))]}};
const snapshot={enabled:true,connected:true,instanceId:'a',hubId:'test-hub',humanPrincipalId:self.principalId,contacts:[self,local,buddy,...bots],conversations:[membership],invites:[self,local].map((person,index)=>({inviteId:'inv-'+index,conversationId:'invite-group',title:'Buddy review',principalId:person.principalId,principalName:person.displayName,inviterPrincipalId:buddy.principalId,inviterName:buddy.displayName,inviterIpAddress:buddy.ipAddress})),outbox:[],errors:[]};
snapshot.invites=[];snapshot.botConversations=[{conversationId:'bot-private',kind:'dm',archive:true,viewerBotId:'local',viewerPrincipalId:local.principalId,membershipEpoch:'private-epoch',joinSeq:1,watermark:1,info:{kind:'dm',members:[local,bots[0]]}}];
snapshot.archivedConversationIds=[];snapshot.conversationPreferencesScope='local-test-scope';
snapshot.conversations.push({...membership,kind:'dm',conversationId:'human-private',info:{members:[self,buddy]}});
const extra={...bots[0],principalId:'bot:b:extra',displayName:'Extra tester'};snapshot.contacts.push(extra);
const events=['@all Review this release','Browser test passed','API test passed'].map((text,index)=>({type:'message',eventId:'event'+index,conversationId:'group',conversationSeq:index+1,serverAcceptedAt:'2026-11-06T00:00:00Z',message:{messageId:'m'+index,author:index?bots[index-1]:self,content:{text},mentions:index?[]:bots.map(bot=>bot.principalId),replyToMessageId:index?'m0':null}}));
const retired={...bots[0],principalId:'bot:b:retired',retired:true,retiredAt:'2026-11-09T00:00:00Z'};membership.info.formerMembers=[retired];events[1].message.author=retired;snapshot.botConversations[0].info.members=[{...local,retired:true},bots[0]];const calls=[];window.fixture={snapshot,calls};
const request=async body=>{calls.push(body);switch(body.endpoint){case 'state':return structuredClone(snapshot);case 'participant-profile':return {principalId:body.targetPrincipalId,publicProfile:{headline:'Testing expert',summary:'Public experience in browser and regression testing.',expertise:['Regression testing','Browser automation'],version:1}};case 'bot-dm-history':return {conversationId:'bot-private',membershipEpoch:'private-epoch',events:[{type:'message',conversationSeq:1,serverAcceptedAt:'2026-11-06T00:00:00Z',message:{messageId:'expert-note',author:bots[0],content:{text:'Recorded Bot-to-Bot expert advice'},mentions:[]}}]};case 'history':return {conversationId:body.conversationId,membershipEpoch:'epoch',events:body.conversationId==='group'?events:[]};
case 'thread':return {conversationId:'group',membershipEpoch:'epoch',messageId:body.messageId,rootMessageId:'m0',watermark:3,events,hasMore:false};
case 'send':if(window.fixture.forceMentionFailure)throw Object.assign(new Error('synthetic'),{code:'UNKNOWN_MENTION'});communicationMentions(body.text,snapshot.conversations.find(item=>item.conversationId===body.conversationId)?.info.members??[]);return {};case 'set-conversation-archived':snapshot.archivedConversationIds=body.archived?[...new Set([...snapshot.archivedConversationIds,body.conversationId])]:snapshot.archivedConversationIds.filter(id=>id!==body.conversationId);return {archivedConversationIds:snapshot.archivedConversationIds};
case 'onboarding-storage':return {enrollments:Array.from({length:24},(_,index)=>({hubId:'synthetic-saved-hub-'+index,url:'wss://synthetic.example.test/communication',status:'approved'}))};
case 'forget-hub':throw Object.assign(new Error('synthetic'),{code:'HUB_SELECTION_CHANGED'});case 'members':return membership.info;case 'available-bots':return {bots:[{id:'local',name:'Local tester'}],publishedBotIds:['local']};case 'user-code':return {userCode:'TEST-USER-CODE'};case 'contact-requests':case 'contact-relations':return [];case 'memory-settings':return {localMemory:true};case 'human-profile-info':return {principalId:self.principalId,publicProfile:{headline:'Testing lead',summary:'Synthetic preview',expertise:[],languages:['English'],version:0}};case 'create-group':return {conversationId:'created'};case 'invite':return {};case 'accept':snapshot.invites=snapshot.invites.filter(item=>item.inviteId!==body.inviteId);return {conversationId:'invite-group'};default:return {}}};
const roster=createSource({ready:true,revision:1,communicationEnabled:true,communicationHubId:'test-hub',bots:[{id:'local',name:'Local tester',publicProfile:{headline:'Regression testing',expertise:['Testing'],languages:['English'],revision:0}}]});
createRoot(document.getElementById('root')).render(React.createElement(CommunicationSurface,{roster,surface:createSource({mode:'bot'}),panel:createSource(true),request}));`
const {outputFiles}=await build({stdin:{contents:entry,resolveDir:client,loader:'js'},bundle:true,format:'iife',platform:'browser',write:false,alias:{react:harness+'/react','react-dom':harness+'/react-dom'},plugins:[{name:'synthetic-platform',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'primitives',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:"import React from 'react';export const FishLogo=()=>null;export const writeClipboard=text=>navigator.clipboard.writeText(text);export const MarkdownText=({text})=>React.createElement('p',null,text);",resolveDir:client,loader:'js'}))}}]})
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'application/javascript':'text/html');res.end(req.url==='/app.js'?outputFiles[0].text:'<!doctype html><html><meta charset="utf-8"><body><div id="root"></div><script src="/app.js"></script></body></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser

try{
 browser=await chromium.launch({...(process.env.DSBOT_CHROMIUM_PATH ? {executablePath:process.env.DSBOT_CHROMIUM_PATH} : {}),headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}`)
 await page.getByRole('button',{name:'Empty review',exact:false}).first().click()
 await page.locator('[data-message-id="m1"] strong').filter({hasText:'Bot no longer exists'}).waitFor()
 for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
  await page.setViewportSize(viewport)
  await page.getByRole('button',{name:'View conversation details',exact:true}).click()
  const members=page.getByRole('complementary',{name:'Group members and receiving rules',exact:true});await members.waitFor()
  assert.equal(await members.locator('[data-principal-id="bot:b:retired"]').count(),0)
  await members.getByRole('button',{name:'Invite participant',exact:true}).click()
  const invite=page.getByRole('dialog',{name:'Invite participant',exact:true});await invite.waitFor()
  const radio=invite.getByRole('radio',{name:'Invite Extra tester',exact:true});await radio.waitFor()
  const metrics=await radio.evaluate(node=>{const input=node.getBoundingClientRect(),label=node.closest('label').getBoundingClientRect(),name=node.closest('label').querySelector('.bt-comm-choice-name').getBoundingClientRect(),dialog=node.closest('dialog').getBoundingClientRect();return {width:input.width,nameRight:name.right,labelRight:label.right,dialogRight:dialog.right}})
  assert.ok(metrics.width<=20,JSON.stringify(metrics));assert.ok(metrics.nameRight<=metrics.dialogRight-8,JSON.stringify(metrics))
  await radio.check();assert.equal(await radio.isChecked(),true)
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
  await page.screenshot({animations:'disabled',path:join(output,`existing-group-invite-${viewport.width}.png`)})
  await invite.getByRole('button',{name:'Cancel',exact:true}).click();await invite.waitFor({state:'detached'})
  await members.getByRole('button',{name:'Close member settings',exact:true}).first().click();await members.waitFor({state:'detached'})
 }
 await page.setViewportSize({width:1280,height:900})
 await page.locator('[aria-label="Bot private chats"] [data-conversation-id]').click()
 await page.getByText('Recorded Bot-to-Bot expert advice',{exact:true}).waitFor()
 assert.equal(await page.getByRole('status').filter({hasText:'This Bot identity no longer exists'}).count(),1)
 assert.equal(await page.locator('.bt-comm-main>footer').count(),0)
 await page.locator('.bt-comm-title-pill').click();const details=page.getByRole('dialog',{name:'Participant information',exact:true});await details.waitFor();assert.match(await details.innerText(),/Bot no longer exists/)
 await page.screenshot({animations:'disabled',path:join(output,'retired-bot-details.png')})
 assert.deepEqual(errors,[])
 console.log('PASS desktop/mobile existing-group radio/name bounds and selection, retired author attribution, read-only retired DM, old identity details; zero browser errors')
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
