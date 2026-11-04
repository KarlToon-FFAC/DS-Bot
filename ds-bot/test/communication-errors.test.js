import assert from 'node:assert/strict'
import {test} from 'node:test'
import {communicationFailure,operationOutcomeUncertain} from '../src/client/communication-errors.js'

test('timeouts, disconnects and unknown errors preserve operation IDs; explicit denials remain terminal',()=>{
  for(const code of ['REQUEST_TIMEOUT','CONNECTION_LOST','STALE_CONNECTION','STORAGE_UNAVAILABLE','BACKPRESSURE','ERR_SQLITE_ERROR','COMMUNICATION_UNAVAILABLE',undefined])assert.equal(operationOutcomeUncertain({code}),true,code)
  for(const code of ['FORBIDDEN','INVALID_REQUEST','GROUP_VERSION_CONFLICT','MEMBERSHIP_REVOKED','MEMBERSHIP_LIMIT'])assert.equal(operationOutcomeUncertain({code}),false,code)
})
test('shared diagnostics expose safe known codes and never arbitrary exception text or unknown code strings',()=>{
  for(const code of ['CREDENTIAL_UNAVAILABLE','EXPLICIT_ACTIVATION_REQUIRED','CONFIG_EDITOR_UNAVAILABLE','REQUEST_TIMEOUT','HUB_TLS_UNTRUSTED','HUB_TLS_HOSTNAME_MISMATCH']){
    const text=communicationFailure({code,message:'DO_NOT_DISPLAY_RAW_SECRET'})
    assert.ok(text.includes(code));assert.doesNotMatch(text,/DO_NOT_DISPLAY_RAW/)
  }
  assert.doesNotMatch(communicationFailure({code:'DO_NOT_DISPLAY_RAW_CODE',message:'DO_NOT_DISPLAY_RAW_SECRET'}),/DO_NOT_DISPLAY_RAW/)
})
