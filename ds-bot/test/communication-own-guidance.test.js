import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {LocalFileSystem} from '@deepseek-ai/dsh-fs-local'
import {ownWorkspaceGuidance} from '../src/host/federation/own-context.js'

test('remote guidance uses the public DSH loader and sees edits and removal on the next request',async t=>{
 const root=mkdtempSync(join(tmpdir(),'dsbot-own-guidance-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
 const priorHome=process.env.DSH_HOME;process.env.DSH_HOME=root
 t.after(()=>{if(priorHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=priorHome})
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 const fs=new LocalFileSystem(ctx,{cwd:root,diffBasisMaxBytes:1048576}),runtime={ctx:{get:name=>name==='fs'?fs:undefined}}
 mkdirSync(join(root,'.git'));mkdirSync(join(root,'sub'))
 writeFileSync(join(root,'AGENTS.md'),'ROOT_INSTRUCTION_FIRST')
 writeFileSync(join(root,'sub','AGENTS.md'),'NESTED_INSTRUCTION')
 assert.match(await ownWorkspaceGuidance(runtime,{},root),/ROOT_INSTRUCTION_FIRST/)
 writeFileSync(join(root,'AGENTS.md'),'ROOT_INSTRUCTION_UPDATED')
 const text=await ownWorkspaceGuidance(runtime,{},join(root,'sub'))
 assert.match(text,/ROOT_INSTRUCTION_UPDATED/);assert.match(text,/NESTED_INSTRUCTION/)
 assert.doesNotMatch(text,/ROOT_INSTRUCTION_FIRST/)
 rmSync(join(root,'AGENTS.md'))
 assert.doesNotMatch(await ownWorkspaceGuidance(runtime,{},root),/ROOT_INSTRUCTION/)
})
