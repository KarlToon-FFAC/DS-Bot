import assert from 'node:assert/strict'
import {test} from 'node:test'
import {communicationFailure,operationOutcomeUncertain} from '../src/client/communication-errors.js'
import {installLocale,DICTIONARY} from '../src/client/i18n.js'

test('fixed onboarding rejections have safe English and Chinese diagnostics; unknown codes stay opaque',()=>{
  const codes=['SECURE_RANDOM_UNAVAILABLE','COMMUNICATION_CREDENTIAL_MISMATCH','COMMUNICATION_NOT_APPROVED','COMMUNICATION_PAIRING_CONFLICT','COMMUNICATION_STORAGE_UNAVAILABLE','CREDENTIAL_STORAGE_READ_ONLY','CREDENTIAL_STORAGE_UNAVAILABLE','ENROLLMENT_CONFLICT','HUB_ADDRESS_FORBIDDEN','HUB_CONFIRMATION_REQUIRED','INVALID_BOT_SCOPE','INVALID_ENROLLMENT_CHALLENGE','INVALID_ENROLLMENT_RESPONSE','INVALID_HUB_CODE','INVALID_REQUEST','JOIN_NOT_SUBMITTED','OPERATION_ID_REQUIRED','UNKNOWN_OPERATION','HUMAN_REQUIRED','AUTHOR_MISMATCH']
  for(const code of codes) assert.match(communicationFailure({code,message:'PRIVATE'}),new RegExp(`\\[${code}\\]$`))
  const off=installLocale({register(){},bind(){return key=>DICTIONARY.zh[key]??key}})
  try {
    for(const code of codes){const value=communicationFailure({code,message:'PRIVATE'});assert.match(value,/[\u4e00-\u9fff]/u);assert.doesNotMatch(value,/PRIVATE/)}
    assert.doesNotMatch(communicationFailure({code:'PRIVATE_UNKNOWN'}),/PRIVATE_UNKNOWN/)
  } finally { off() }
})

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
