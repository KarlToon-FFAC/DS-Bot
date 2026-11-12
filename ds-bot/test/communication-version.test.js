import test from 'node:test'
import assert from 'node:assert/strict'
import { COMMUNICATION_VERSION, communicationCompatibility, incompatibleCommunication } from '../src/shared/communication-version.js'
import { COMMUNICATION_VERSION as HUB_VERSION } from '../../communication-hub/src/version.js'

test('Hub and client report their own releases and distinguish compatible differences from capability failures',()=>{
 assert.equal(communicationCompatibility({communicationVersion:COMMUNICATION_VERSION}).status,'matched')
 const older=communicationCompatibility({communicationVersion:'2026.11.01.1'})
 assert.equal(older.status,'different');assert.equal(older.hubVersion,'2026.11.01.1')
 const mismatch=communicationCompatibility({communicationVersion:HUB_VERSION},'BOT_PUBLICATION_MIGRATION_REQUIRED')
 assert.equal(mismatch.status,'incompatible');assert.equal(mismatch.code,'BOT_PUBLICATION_MIGRATION_REQUIRED')
 assert.equal(communicationCompatibility(null,'CONNECTION_LOST').status,'unknown')
 assert.equal(incompatibleCommunication('PROTOCOL_VERSION_UNSUPPORTED'),true)
 for(const value of [{},'<private data>','x'.repeat(500)])assert.equal(communicationCompatibility({communicationVersion:value}).hubVersion,null)
})

test('both current versions use semantic package versions and render with a V prefix',async()=>{
 const {displayCommunicationVersion}=await import('../src/shared/communication-version.js')
 assert.match(COMMUNICATION_VERSION,/^\d+\.\d+\.\d+(?:-T\d+)?$/)
 assert.equal(displayCommunicationVersion(COMMUNICATION_VERSION),`V${COMMUNICATION_VERSION.replace(/-T(\d+)$/, 'T$1')}`)
 assert.equal(displayCommunicationVersion(HUB_VERSION),`V${HUB_VERSION.replace(/-T(\d+)$/, 'T$1')}`)
 assert.equal(displayCommunicationVersion(null),null)
})

test('release ordering is advisory and does not infer a protocol incompatibility',async()=>{
 const {communicationReleaseRelation:relation}=await import('../src/shared/communication-version.js')
 assert.equal(relation('0.2.8','0.2.9'),'client-older')
 assert.equal(relation('0.3.5','0.3.5-T2'),'client-older')
 assert.equal(relation('V0.3.5T2','0.3.5-T2'),'same')
 assert.equal(relation('0.3.5-T10','0.3.5-T2'),'client-newer')
 assert.equal(relation('0.2.10','0.2.9'),'client-newer')
 assert.equal(relation('V0.2.8','0.2.8+gui'),'same')
 assert.equal(relation('0.2.8','2026.11.09.2'),'unknown')
 assert.equal(relation('0.2.8','0.3.0-rc.1'),'unknown')
 const compatible=communicationCompatibility({communicationVersion:'999.0.0'})
 assert.equal(compatible.status,'different');assert.equal(compatible.releaseRelation,'client-older')
 assert.equal(compatible.updateTarget,null)
 const rejected=communicationCompatibility({communicationVersion:'999.0.0',protocol:'dsbot-communication/2',updateTarget:'client'},'PROTOCOL_VERSION_UNSUPPORTED')
 assert.equal(rejected.status,'incompatible');assert.equal(rejected.updateTarget,'client')
 assert.equal(rejected.protocol,'dsbot-communication/2')
})
