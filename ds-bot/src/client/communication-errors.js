import { t } from './i18n.js'

import { communicationDescriptions as descriptions } from '../shared/communication-diagnostics.js'

export const knownCommunicationFailure = error => Object.hasOwn(descriptions, error?.code ?? '')
export const communicationFailure = error => knownCommunicationFailure(error)
  ? t(descriptions[error.code]) + ` [${error.code}]`
  : t('The action could not be confirmed. Check current status before trying again.')

// Only explicit precondition/authorization rejections release an intent ID.
const definitive = new Set(['COMMUNICATION_RELOAD_REQUIRED','PROACTIVE_ROOT_CAPABILITY_REQUIRED','PUBLIC_PROFILE_VERSION_CONFLICT','PROFILE_VERSION_CONFLICT','INVALID_PUBLIC_PROFILE','PUBLIC_PROFILE_SECRET_REFUSED','PUBLIC_PROFILE_CAPABILITY_REQUIRED','INSTANCE_AUTHENTICATION_REQUIRED','AMBIGUOUS_MENTION','UNKNOWN_MENTION','PAYLOAD_TOO_LARGE','UNSUPPORTED_CONTENT',
  'NOT_A_MEMBER','MEMBERSHIP_REVOKED','FORBIDDEN','INVALID_REPLY_TARGET','REFERENCE_NOT_AVAILABLE','SPEAKING_FORBIDDEN','PASSIVE_REPLY_REQUIRED',
  'PASSIVE_REPLY_ONLY','GROUP_VERSION_CONFLICT','OWNER_TRANSFER_REQUIRED','OWNER_UNAVAILABLE','OWNER_RECLAIM_REQUIRED','UNKNOWN_OPERATION','INVALID_REQUEST','INVALID_OPERATION',
  'UNAUTHENTICATED','PEER_REVOKED','MEMBERSHIP_LIMIT','BOT_NOT_PUBLISHED','BOT_RETIRED','CONTACT_REQUIRED','UNKNOWN_PRINCIPAL','OPERATION_ID_CONFLICT'])
export const operationOutcomeUncertain = error => !definitive.has(error?.code)
