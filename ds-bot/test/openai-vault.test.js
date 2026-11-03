import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const script=fileURLToPath(new URL('../dev/communication/openai-vault.ps1',import.meta.url))
for(const brokenModulePath of [false,true])test(`native CurrentUser DPAPI lifecycle with synthetic input${brokenModulePath?' and inherited incompatible module path':''}`,{skip:process.platform!=='win32'},()=>{
  const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',script,'-Action','SelfTest'],
    {encoding:'utf8',timeout:30000,windowsHide:true,env:{...process.env,...(brokenModulePath?{PSModulePath:'C:\\nonexistent-dsbot-synthetic-module-path'}:{})}})
  assert.equal(result.status,0,result.stdout)
  assert.match(result.stdout,/PASS_VAULT_SELFTEST/)
  assert.doesNotMatch(result.stdout,/sk-proj-|synthetic-[a-f0-9]{32}/)
})
