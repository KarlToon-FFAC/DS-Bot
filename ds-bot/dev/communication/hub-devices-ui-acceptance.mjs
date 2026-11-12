// Owned loopback Hub only: actual admin auth, public profiles and deletion; no DSH/user data.
import assert from 'node:assert/strict'
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {startHub} from '../../../communication-hub/src/server.js'
import {enrollmentTranscript} from '../../../communication-hub/src/management-store.js'
import {CAPABILITIES,PROTOCOL} from '../../../communication-hub/src/protocol.js'
const {chromium}=await import(process.env.DSBOT_PLAYWRIGHT_MODULE??'playwright')
const output=resolve('.dsh-test-tools/hub-devices-ui');mkdirSync(output,{recursive:true})
const password='synthetic-only-hub-devices-browser-password'
const hub=await startHub({databasePath:':memory:',port:0,management:{enabled:true,password}})
let browser
const evidence={status:'RUNNING',cases:[],screenshots:[]},record=value=>{evidence.cases.push(value);console.log('PASS',value)}
const op=value=>({operationId:randomUUID(),...value})
function enroll(label){
 const key=generateKeyPairSync('ed25519'),socket={},challenge=hub.management.challenge(socket,{purpose:'join',publicKey:key.publicKey.export({type:'spki',format:'pem'}).toString()},'fixture-'+randomUUID())
 const pending=hub.management.prove(socket,{challengeId:challenge.challengeId,signature:sign(null,Buffer.from(enrollmentTranscript(challenge)),key.privateKey).toString('base64url'),displayName:label})
 const accepted=hub.management.decide({requestId:pending.requestId,expectedVersion:1,action:'approve'})
 const auth=hub.store.connect(accepted.instanceId,label,CAPABILITIES,'0.3.6')
 return {auth,principalId:`human:${auth.instanceId}:local-user`}
}
try{
 const old=enroll('Reset workstation'),fresh=enroll('Reset workstation')
 assert.equal(hub.management.instances().find(i=>i.instanceId===old.auth.instanceId).clientVersion,'0.3.6')
 for(let n=0;n<30;n++){const peer=enroll('Workstation '+String(n+1).padStart(2,'0'));if(n%5===0)hub.management.revoke(peer.auth.instanceId)}
 const bot=hub.store.register(old.auth,{localId:'synthetic-bot',kind:'bot',displayName:'Testing expert'}).principalId
 for(const principalId of [old.principalId,bot])hub.store.updatePublicProfile(old.auth,op({principalId,expectedVersion:0,profile:{headline:'Published before the client reset',expertise:['testing']}}))
 hub.store.updatePublicProfile(fresh.auth,op({principalId:fresh.principalId,expectedVersion:0,profile:{headline:'Keep this fresh device'}}))
 const retainedProfile=hub.store.publicProfileOf(fresh.principalId)
 const contact=hub.management.requestContact(old.auth,op({principalId:old.principalId,userCode:hub.management.code(fresh.auth,{principalId:fresh.principalId}).userCode,botPrincipalIds:[]}))
 hub.management.respondContact(fresh.auth,op({principalId:fresh.principalId,requestId:contact.requestId,expectedVersion:1,botPrincipalIds:[]}), 'accept')
 const group=hub.store.createGroup(old.auth,op({principalId:old.principalId,title:'Retain shared history'})).conversationId
 const epoch=hub.store.member(old.auth,group,old.principalId).epoch
 const invite=hub.store.invite(old.auth,op({principalId:old.principalId,conversationId:group,membershipEpoch:epoch,inviteePrincipalId:fresh.principalId}))
 hub.store.accept(fresh.auth,op({principalId:fresh.principalId,inviteId:invite.inviteId}))
 const messageId=randomUUID()
 hub.store.publish(old.auth,{protocol:PROTOCOL,type:'message.publish',messageId,conversationId:group,membershipEpoch:epoch,author:{principalId:old.principalId,homeInstanceId:old.auth.instanceId,kind:'human'},content:{format:'text',text:'Shared history must remain'},mentions:[],replyToMessageId:null,clientCreatedAt:new Date().toISOString()})
 browser=await chromium.launch({executablePath:process.env.DSBOT_CHROMIUM_PATH??'/usr/bin/chromium',headless:true,args:['--no-sandbox']})
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 await page.goto(`http://127.0.0.1:${hub.port}/admin/`)
 await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click()
 await page.locator('#instances .device-row').first().waitFor()
 assert.equal(await page.locator('#instances .device-row').count(),25)
 assert.equal(await page.locator('#instances input').count(),0)
 assert.match(await page.locator('#instances .device-row').first().innerText(),/V0\.3\.6/)
 record('device list shows each authenticated client release version')
 assert.ok(await page.locator('#instances .device-row').first().evaluate(e=>e.getBoundingClientRect().height<=60))
 await page.screenshot({path:join(output,'desktop-list.png')});evidence.screenshots.push('desktop-list.png')
 await page.getByRole('button',{name:'下一页',exact:true}).click();assert.equal(await page.locator('#instances .device-row').count(),7)
 await page.locator('#device-filter').selectOption('revoked');assert.equal(await page.locator('#instances .device-row').count(),6)
 await page.locator('#device-filter').selectOption('all')
 record('authenticated compact device rows, counts, status filters and 25-row pagination work on the real Hub')
 await page.setViewportSize({width:390,height:844})
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
 assert.ok(await page.locator('#instances .device-row').first().evaluate(e=>e.getBoundingClientRect().height<=85))
 await page.screenshot({path:join(output,'mobile-list.png')});evidence.screenshots.push('mobile-list.png')
 await page.locator('#device-search').fill(old.auth.instanceId)
 await page.locator('#instances .device-manage').click()
 await page.getByRole('button',{name:'彻底删除设备',exact:true}).click()
 await page.locator('#device-confirm[open]').waitFor()
 const impact=await page.locator('#device-confirm-body').textContent()
 assert.ok(impact.includes(old.auth.instanceId)&&impact.includes(group)&&impact.includes('Retain shared history'))
 assert.ok(!impact.includes(fresh.auth.instanceId))
 assert.ok(await page.locator('#device-confirm').evaluate(e=>e.getBoundingClientRect().right<=innerWidth))
 await page.screenshot({path:join(output,'mobile-delete.png')});evidence.screenshots.push('mobile-delete.png')
 await page.keyboard.press('Escape');assert.equal(await page.locator('#device-confirm[open]').count(),0)
 assert.ok(hub.management.peer(old.auth.instanceId))
 await page.keyboard.press('Escape');assert.equal(await page.locator('#device-dialog[open]').count(),0)
 assert.ok(await page.locator('#instances .device-manage').evaluate(e=>e===document.activeElement))
 record('mobile dialogs fit the viewport, exact duplicate-name identity/group impact is visible, Escape cancels and restores focus')
 await page.setViewportSize({width:1280,height:900})
 await page.locator('#instances .device-manage').click()
 await page.locator('#device-details form input').fill('Old reset workstation')
 await page.getByRole('button',{name:'保存名称',exact:true}).click()
 await page.getByRole('heading',{name:'Old reset workstation',exact:true}).waitFor()
 await page.getByRole('button',{name:'撤销访问权限',exact:true}).click()
 await page.locator('#device-confirm-submit').click()
 await page.getByText('访问已撤销',{exact:true}).waitFor()
 await page.getByRole('button',{name:'彻底删除设备',exact:true}).click()
 await page.screenshot({path:join(output,'desktop-delete.png')});evidence.screenshots.push('desktop-delete.png')
 await page.getByRole('button',{name:'彻底删除',exact:true}).click()
 await page.locator('#device-dialog[open]').waitFor({state:'detached'})
 assert.equal(hub.management.peer(old.auth.instanceId),undefined)
 assert.ok(hub.management.peer(fresh.auth.instanceId))
 assert.deepEqual(hub.store.publicProfileOf(fresh.principalId),retainedProfile)
 assert.ok(hub.store.db.prepare('SELECT 1 FROM messages WHERE id=?').get(messageId))
 assert.equal(hub.store.db.prepare('SELECT closed FROM conversations WHERE id=?').get(group).closed,1)
 assert.deepEqual(hub.store.db.prepare('PRAGMA foreign_key_check').all(),[])
 record('real modal rename/revoke/permanent delete removes an offline reset identity with public profiles while retaining the other same-name device and shared history')
 assert.deepEqual(errors,[])
 evidence.status='PASS'
}catch(error){evidence.status='FAIL';evidence.error=error.code??error.message;throw error}
finally{await browser?.close();await hub.close();writeFileSync(join(output,'evidence.json'),JSON.stringify(evidence,null,2))}
