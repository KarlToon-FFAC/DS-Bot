import assert from 'node:assert/strict'
import {test} from 'node:test'
import {build} from 'esbuild'
import {runInNewContext} from 'node:vm'
import {createRequire} from 'node:module'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
const harness=createRequire(join(process.env.DSH_HARNESS,'package.json'))
const {outputFiles}=await build({entryPoints:[fileURLToPath(new URL('../src/client/communication-recipient-preview.js',import.meta.url))],bundle:true,platform:'browser',format:'cjs',external:['react','react-dom','@deepseek-ai/dsh-client-ui-primitives'],write:false})
const mod={exports:{}}
runInNewContext(outputFiles[0].text,{module:mod,exports:mod.exports,require:id=>id==='react'?harness('react'):{},window:{}})
const {previewRecipients}=mod.exports
const bot=id=>({principalId:`bot:a:${id}`,kind:'bot',displayName:id,speakingMode:'passive',published:true})
const A=bot('Alpha'),B=bot('Beta'),H={principalId:'human:a:h',kind:'human',displayName:'Human'}
const member={kind:'group',membershipVersion:1,info:{membershipVersion:1,members:[A,B,H],routingMode:'admin',defaultBotPrincipalIds:[A.principalId,B.principalId]}}
const ids=result=>Array.from(result.bots,p=>p.principalId).sort()

test('preview resolves typed mentions, all, replies, Human overrides and defaults using Hub policy',()=>{
 const cases=[
  [{text:'hello'},null,[A.principalId,B.principalId]],
  [{text:'@Beta help'},null,[B.principalId]],
  [{text:'@all help'},null,[A.principalId,B.principalId]],
  [{text:'thanks'},{messageId:'m',author:A},[A.principalId]],
  [{text:'human chat'},{messageId:'m',author:H},[]],
  [{text:'@Human hello'},{messageId:'m',author:A},[]],
  [{text:'@Beta help'},{messageId:'m',author:A},[B.principalId]],
  [{text:'> @all quoted\n@Beta 你收到@你的消息了吗'},null,[B.principalId]],
 ]
 for(const [draft,target,expected] of cases)assert.deepEqual(ids(previewRecipients(member,draft,target,true)),expected.sort())
 assert.deepEqual(ids(previewRecipients(member,{text:'@Human hello'},{messageId:'m',author:A},false)),[A.principalId])
 assert.deepEqual(ids(previewRecipients({...member,kind:'dm'},{text:'hello'},null,true)),[A.principalId,B.principalId])
})

test('preview does not invent recipients for stale membership or invalid mentions',()=>{
 assert.equal(previewRecipients({...member,membershipVersion:2},{text:'hello'},null,true).unavailable,true)
 assert.equal(previewRecipients(member,{text:'@missing'},null,true).error,'UNKNOWN_MENTION')
 const hidden={...member,info:{...member.info,members:[{...A,published:false},{...B,speakingMode:'silent'},H]}}
 assert.deepEqual(ids(previewRecipients(hidden,{text:'hello'},null,true)),[])
})
