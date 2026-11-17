// Production quote/thread components and themes; synthetic messages, no account data.
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {mkdirSync,writeFileSync} from 'node:fs'
import {createServer} from 'node:http'
import {resolve,join} from 'node:path'
const {chromium}=await import(process.env.DSBOT_PLAYWRIGHT_MODULE??'playwright')
const root=resolve(import.meta.dirname,'../..'),client=join(root,'src/client'),harness=join(root,'dev/harness/node_modules')
const output=resolve(process.argv[2]??join(root,'../.dsh-test-tools/quote-contrast-ui'));mkdirSync(output,{recursive:true})
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {UserMessageCell,USER_MESSAGE_CSS} from '${client}/user-message.js';import {SideChatView,SIDE_CSS} from '${client}/side-chat.js';
import {CommunicationSurface} from '${client}/communication.js';import {createSource} from '${client}/sources.js';
import {SHELL_CSS} from '${client}/styles.js';import {themeCss,allThemes} from '${client}/themes.js';
import {communicationCSS} from '${client}/communication-styles.js';import {communicationDirectoryCSS} from '${client}/communication-directory-styles.js';
const style=document.createElement('style');style.textContent=SHELL_CSS+USER_MESSAGE_CSS+SIDE_CSS+communicationCSS+communicationDirectoryCSS+'body{background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font)}';document.head.append(style);
const themeStyle=document.createElement('style');document.head.append(themeStyle);
const self={principalId:'human:a:owner',kind:'human',displayName:'Alice',role:'owner',speakingMode:'speak'},peer={principalId:'bot:b:helper',kind:'bot',displayName:'Test Bot',role:'member',speakingMode:'passive',published:true};
const group={conversationId:'group',title:'Reply reference readability',kind:'group',role:'owner',speakingMode:'speak',membershipEpoch:'epoch',membershipVersion:1,joinSeq:1,watermark:4,info:{members:[self,peer]}};
const event=(seq,author,text,replyToMessageId)=>({type:'message',conversationId:'group',conversationSeq:seq,eventId:'event-'+seq,serverAcceptedAt:new Date(Date.UTC(2026,10,11,0,0,seq)).toISOString(),message:{messageId:'message-'+seq,author,content:{text},mentions:[],...(replyToMessageId?{replyToMessageId}:{})}});
const events=[event(1,peer,'Please verify that quoted source text remains readable.'),event(2,self,'I can read the source above this reply.','message-1'),event(3,peer,'Quoted replies should be readable in either direction.','message-2'),event(4,self,'The original message is outside available history.','unavailable')];
const snapshot={enabled:true,connected:true,reconciled:true,instanceId:'a',humanPrincipalId:self.principalId,contacts:[self,peer],conversations:[group],invites:[],outbox:[{id:'queued-own',type:'message.publish',state:'pending',conversationId:'group',membershipEpoch:'epoch',principalId:self.principalId,text:'Queued own message'}],errors:[]};
const request=async body=>{switch(body.endpoint){case 'state':return structuredClone(snapshot);case 'history':return {conversationId:'group',membershipEpoch:'epoch',events,watermark:4,joinSeq:1};case 'reference':return events.find(event=>event.message.messageId===body.messageId)??{};case 'thread':return {conversationId:'group',membershipEpoch:'epoch',messageId:body.messageId,rootMessageId:'message-1',events:events.slice(0,3),hasMore:false,watermark:4};case 'contact-requests':case 'contact-relations':return [];default:return {}}};
const panel=createSource(false);window.fixture={open:()=>panel.set(true),theme:(name,dark)=>{themeStyle.textContent=themeCss(allThemes()[name]);document.body.toggleAttribute('data-ds-dark-theme',dark)}};
window.fixture.theme('deepseek',false);
const localRoster={roomsById:{},byId:{},bots:[]};
createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,
React.createElement('main',{id:'local-sender-preview',style:{maxWidth:680,margin:'24px auto',padding:12,boxSizing:'border-box'}},
['A short local message.','A long local message '.repeat(40)].map((text,index)=>React.createElement(UserMessageCell,{key:index,node:{data:{content:[{type:'text',text}]}},sessionId:'local',useRoster:select=>select(localRoster),actions:{}})),
React.createElement(SideChatView,{subject:'local',chat:{id:'side',entries:[{id:'one',status:'completed',question:'My side question.',answer:'A local answer.'}]},actions:{}})),
React.createElement(CommunicationSurface,{roster:createSource({ready:true,communicationEnabled:true,remoteHubEnabled:true,bots:[]}),surface:createSource({mode:'bot'}),panel,request})));`
const {outputFiles}=await build({stdin:{contents:entry,resolveDir:client,loader:'js'},bundle:true,format:'iife',platform:'browser',write:false,alias:{react:harness+'/react','react-dom':harness+'/react-dom'},plugins:[{name:'synthetic-platform',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'primitives',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:"import React from 'react';export const projectUserText=text=>text;export const FishLogo=()=>null;export const writeClipboard=()=>{};export const MarkdownText=({text})=>React.createElement('p',null,text);",resolveDir:client,loader:'js'}))}}]})
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'application/javascript':'text/html');res.end(req.url==='/app.js'?outputFiles[0].text:'<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script src="/app.js"></script></body></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser
// Composite all ancestor backgrounds before comparing the actual rendered text.
const contrast=async locator=>locator.evaluate(node=>{
 const rgba=value=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=value;ctx.fillRect(0,0,1,1);const [r,g,b,a]=ctx.getImageData(0,0,1,1).data;return [r,g,b,a/255]}
 const over=(front,back)=>front.slice(0,3).map((v,i)=>v*front[3]+back[i]*(1-front[3]));const chain=[];let ancestor=node
 while(ancestor){chain.unshift(ancestor);ancestor=ancestor.parentElement}
 let background=[255,255,255];for(const element of chain)background=over(rgba(getComputedStyle(element).backgroundColor),background)
 const color=rgba(getComputedStyle(node).color);color[3]*=chain.reduce((opacity,element)=>opacity*Number(getComputedStyle(element).opacity),1)
 const ink=over(color,background),luminance=channels=>channels.map(value=>{const s=value/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4}).reduce((total,v,i)=>total+v*[.2126,.7152,.0722][i],0)
 const values=[luminance(ink),luminance(background)].sort((a,b)=>b-a)
 return {ratio:(values[0]+.05)/(values[1]+.05),color:getComputedStyle(node).color,background:background.map(Math.round)}
})
const evidence={cases:[],errors:[]}
try{
 browser=await chromium.launch({...(process.env.DSBOT_CHROMIUM_PATH?{executablePath:process.env.DSBOT_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']})
 for(const [size,viewport]of [['desktop',{width:1280,height:900}],['mobile',{width:390,height:844}]] ){
  const page=await browser.newPage({viewport,reducedMotion:'reduce'});page.on('pageerror',error=>evidence.errors.push(error.message))
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.locator('#local-sender-preview .bt-umsg .bt-user-avatar').first().waitFor()
  for(const dark of [false,true]){
   await page.evaluate(dark=>window.fixture.theme('deepseek',dark),dark)
   for(const row of await page.locator('#local-sender-preview :is(.bt-umsg,.bt-side-qrow)').all()){
    const avatar=await row.locator('.bt-user-avatar').boundingBox(),bubble=await row.locator('.bt-ubody,.bt-side-q').boundingBox()
    assert.ok(avatar&&bubble&&avatar.width>=28&&avatar.x>=bubble.x+bubble.width-1,'local sender avatar is beside the bubble')
    assert.ok(avatar.x+avatar.width<=viewport.width,'local sender avatar stays inside viewport')
   }
   await page.screenshot({path:join(output,'local-senders-'+size+'-'+(dark?'dark':'light')+'.png'),animations:'disabled'})
  }
  await page.evaluate(()=>window.fixture.open());await page.locator('[data-conversation-id="group"]').first().click()
  const quote=page.locator('[data-message-id="message-2"] .bt-comm-quote'),received=page.locator('[data-message-id="message-3"] .bt-comm-quote'),unavailable=page.locator('[data-message-id="message-4"] .bt-comm-quote')
  await quote.locator('.bt-comm-quote-text').waitFor();await received.locator('.bt-comm-quote-text').waitFor();await unavailable.filter({hasText:'Earlier message unavailable'}).waitFor()
  assert.ok(await page.locator('.bt-comm-log time[datetime]').evaluateAll(nodes=>nodes.length>0&&nodes.every(node=>node.textContent.includes(String(new Date(node.dateTime).getFullYear())))),'main message times visibly include the year')
  for(const theme of ['deepseek','mono','paper','moonlight'])for(const dark of [false,true]){
   await page.evaluate(({theme,dark})=>window.fixture.theme(theme,dark),{theme,dark});await page.mouse.move(1,1)
   for(const id of ['message-2','message-4','queued-own']){
    const row=page.locator('[data-message-id="'+id+'"]')
    const avatar=row.locator(':scope > .bt-comm-avatar,:scope > .bt-comm-avatar-button')
    assert.equal(await avatar.count(),1)
    const a=await avatar.boundingBox(),b=await row.locator(':scope > .bt-comm-message-bubble,:scope > .bt-comm-pending-text').boundingBox()
    assert.ok(a&&b&&a.width>=28&&a.height>=28&&a.x>=b.x+b.width-1,'own sender avatar remains visible to the right')
    assert.ok(a.x+a.width<=viewport.width,'remote sender avatar stays inside viewport')
   }
   const samples={own:await contrast(quote),received:await contrast(received),unavailable:await contrast(unavailable)}
   await quote.hover();samples.hover=await contrast(quote);await quote.focus();samples.focus=await contrast(quote)
   for(const [state,sample]of Object.entries(samples))assert.ok(sample.ratio>=4.5,JSON.stringify({size,theme,dark,state,...sample}))
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow')
   evidence.cases.push({size,theme,dark,samples})
   if(theme==='deepseek')await page.screenshot({path:join(output,'quotes-'+size+'-'+(dark?'dark':'light')+'.png'),animations:'disabled'})
  }
  await page.evaluate(()=>window.fixture.theme('deepseek',true))
  await page.locator('[data-message-id="message-2"] .bt-comm-body').click({button:'right'})
  let context=page.locator('[data-action-menu]:not([data-leaving])')
  await context.waitFor();assert.ok(await context.getByRole('menuitem',{name:'Copy',exact:true}).count())
  const menuBox=await context.boundingBox();assert.ok(menuBox.x>=0&&menuBox.y>=0&&menuBox.x+menuBox.width<=viewport.width&&menuBox.y+menuBox.height<=viewport.height)
  await page.keyboard.press('ArrowDown');assert.equal(await context.evaluate(node=>node.contains(document.activeElement)),true)
  await page.screenshot({path:join(output,'message-context-menu-'+size+'.png'),animations:'disabled'})
  await context.getByRole('menuitem',{name:'Reply',exact:true}).click()

  const original=page.locator('[data-thread-message-id="message-1"] .bt-comm-body'),composer=page.locator('.bt-comm-thread-composer .bt-comm-reference')
  await original.waitFor();await composer.waitFor()
  assert.equal(await page.locator('[data-thread-message-id="message-2"] time').textContent(),await page.locator('[data-message-id="message-2"] time').textContent(),'main and reply chain show the same full timestamp')
  for(const dark of [false,true]){
   await page.evaluate(dark=>window.fixture.theme('deepseek',dark),dark)
   const samples={original:await contrast(original),composer:await contrast(composer)}
   for(const sample of Object.values(samples))assert.ok(sample.ratio>=4.5,JSON.stringify({size,dark,...sample}))
   evidence.cases.push({size,dark,surface:'thread',samples})
   await page.screenshot({path:join(output,'thread-quotes-'+size+'-'+(dark?'dark':'light')+'.png'),animations:'disabled'})
  }
  await page.locator('[data-thread-message-id="message-1"] .bt-comm-body').click({button:'right'})
  context=page.locator('[data-action-menu]:not([data-leaving])');await context.waitFor()
  await page.keyboard.press('Escape');await context.waitFor({state:'hidden'})
  assert.equal(await page.locator('.bt-comm-thread-popover').count(),1,'Escape dismisses only the menu')
  evidence.cases.push({size,surface:'message-and-thread-context-menu',keyboard:true,insideViewport:true})
  await page.close();console.log('PASS '+size+' four themes/light-dark: own, received, unavailable, hover, focus, reply chain and composer quotes meet 4.5:1')
 }
 assert.deepEqual(evidence.errors,[]);writeFileSync(join(output,'evidence.json'),JSON.stringify(evidence,null,2))
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
