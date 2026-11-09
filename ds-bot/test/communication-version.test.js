import test from 'node:test'
import assert from 'node:assert/strict'
import { COMMUNICATION_VERSION, communicationCompatibility, incompatibleCommunication } from '../src/shared/communication-version.js'
import { COMMUNICATION_VERSION as HUB_VERSION } from '../../communication-hub/src/version.js'

test('Hub and client share a federation release and distinguish compatible differences from capability failures',()=>{
 assert.equal(COMMUNICATION_VERSION,HUB_VERSION)
 assert.equal(communicationCompatibility({communicationVersion:HUB_VERSION}).status,'matched')
 const older=communicationCompatibility({communicationVersion:'2026.11.01.1'})
 assert.equal(older.status,'different');assert.equal(older.hubVersion,'2026.11.01.1')
 const mismatch=communicationCompatibility({communicationVersion:HUB_VERSION},'BOT_PUBLICATION_MIGRATION_REQUIRED')
 assert.equal(mismatch.status,'incompatible');assert.equal(mismatch.code,'BOT_PUBLICATION_MIGRATION_REQUIRED')
 assert.equal(communicationCompatibility(null,'CONNECTION_LOST').status,'unknown')
 assert.equal(incompatibleCommunication('PROTOCOL_VERSION_UNSUPPORTED'),true)
 for(const value of [{},'<private data>','x'.repeat(500)])assert.equal(communicationCompatibility({communicationVersion:value}).hubVersion,null)
})
