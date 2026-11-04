import { t } from './i18n.js'

const descriptions = {
  HUB_TLS_UNTRUSTED: 'The Hub certificate authority is not trusted. Verify its public CA fingerprint with the administrator and launch the app with NODE_EXTRA_CA_CERTS. Restart the app; keep TLS verification enabled.',
  HUB_TLS_HOSTNAME_MISMATCH: 'The Hub address does not match the certificate. Ask its administrator for a certificate covering this exact reachable hostname or IP.',
  HUB_TLS_CERT_EXPIRED: 'The Hub certificate has expired. Ask its administrator to renew it.',
  HUB_TLS_CERT_TIME_INVALID: 'The Hub certificate is not valid yet. Check both clocks and the certificate dates.',
  HUB_CONNECTION_REFUSED: 'The Hub refused the connection. Check its listening address and existing network routing with the administrator.',
  HUB_CONNECTION_TIMEOUT: 'The Hub connection timed out. Local code review does not establish reachability; check the actual address and network route.',
  HUB_UNREACHABLE: 'Cannot establish the Hub connection. Check its reachable WSS address and trusted certificate.',
  INSTANCE_AUTHENTICATION_REQUIRED: 'This browser session needs the instance startup login.',
  AMBIGUOUS_MENTION: 'Choose the exact participant in the mention picker.', UNKNOWN_MENTION: 'Choose a current participant to mention.',
  PAYLOAD_TOO_LARGE: 'The message exceeds the text limit. Split it into separate messages.', UNSUPPORTED_CONTENT: 'Only text and Markdown are supported.',
  OUTBOX_FULL: 'The send queue is full. Wait for the connection to recover.', NOT_A_MEMBER: 'You are no longer a member of this conversation.',
  MEMBERSHIP_REVOKED: 'Your membership changed. Refresh the conversation.', FORBIDDEN: 'You do not have permission for this group operation.',
  INVALID_REPLY_TARGET: 'That message is not an authorized reply target in this conversation.',
  REFERENCE_NOT_AVAILABLE: 'The referenced message is outside your authorized history.',
  SPEAKING_FORBIDDEN: 'You have read-only access to this group.', PASSIVE_REPLY_REQUIRED: 'This Bot can only reply to an authorized message.',
  PASSIVE_REPLY_ONLY: 'This Bot can only reply to an authorized message.', GROUP_VERSION_CONFLICT: 'Group settings changed. Review the current members and try again.',
  OWNER_TRANSFER_REQUIRED: 'Transfer ownership before leaving or removing the owner.', OWNER_RECLAIM_REQUIRED: 'Restore your retained ownership first.',
  CONVERSATION_PENDING: 'The conversation is waiting for a connection.', COMMUNICATION_READ_ONLY: 'This instance is read-only.',
  UNAUTHENTICATED: 'The Hub rejected this device. Ask the Hub owner to check its pairing.',
  PEER_REVOKED: 'This device was unpaired. Ask the Hub owner to pair it again.',
  AUTHORIZATION_PENDING: 'Membership is still syncing. Wait for the connection to recover.',
  HISTORY_GAP: 'Some history is missing. Wait for synchronization before sending.',
  STALE_CONNECTION: 'Another connection replaced this one. Close the duplicate instance and restart this one.',
  UNSUPPORTED_CAPABILITY: 'This device and the Hub use incompatible versions. Update them to the same revision.',
  BOUNDED_COLLABORATION_REQUIRED: 'Upgrade the Hub to support bounded Bot collaboration. Your queued messages are retained.',
  EXPLICIT_ACTIVATION_REQUIRED: "Update this device and the Hub together: explicit Bot activation is required. Queued intents are retained.",
  CONNECTION_LOST: "The Hub connection was lost. Refresh status before retrying the same operation; it may already be committed.",
  REQUEST_TIMEOUT: "The Hub response timed out. Refresh status before retrying the same operation; it may already be committed.",
  STORAGE_UNAVAILABLE: "The Hub temporarily cannot store this operation. Its original request ID is retained.",
  BACKPRESSURE: "The Hub is busy. Its original request ID is retained.",
  COMMUNICATION_UNAVAILABLE: "Remote communication is not ready. Check connection status and refresh without repeating the operation.",
  COMMUNICATION_NOT_CONFIGURED: "This profile has no active Hub configuration. Check the approved device profile.",
  CREDENTIAL_UNAVAILABLE: "The instance credential provider is unavailable. Restart with the intended private credential source; do not send its value.",
  COMMUNICATION_PRESET_UNAVAILABLE: 'This DSH runtime lacks the required isolated communication preset API. Check the supported DSH version.',
  COMMUNICATION_PRESET_CONFLICT: 'An isolated communication preset is already registered. Check for duplicate DS Bot plugin instances; do not remove isolation.',
  SCHEMA_VERSION_UNSUPPORTED: 'The stored communication database requires a different application version. Preserve the data and check the matching Hub/client versions.',
  ERR_UNKNOWN_BUILTIN_MODULE: 'This runtime lacks a required Node built-in module. Use the supported Node and DSH versions.',
  CONFIG_EDITOR_UNAVAILABLE: "This DSH version has no supported configuration editor. Check the installed DSH version.",
  CONFIG_ENTRY_UNAVAILABLE: "The active DS Bot configuration entry could not be identified. Check the loaded profile and plugin.",
  CONFIG_EDIT_OVERLAID: "A home or command-line overlay blocks saving this setting. Review the launch configuration without exposing credentials.",
  CONFIG_EDIT_ENTRY_CHANGED: "The configuration changed during reload. Refresh the published Bot selection before applying again.",
  CONFIG_EDIT_NOT_ACTIVE: "The configuration plugin reloaded. Refresh the effective settings before applying again.",
  COMMUNICATION_CONFIG_WRITE_FAILED: "The configuration save could not be confirmed. Refresh the published Bot selection before applying again.",
  TLS_REQUIRED: 'This Hub address requires a secure connection. Ask the Hub owner for its trusted WSS address.',
}
export const knownCommunicationFailure = error => Object.hasOwn(descriptions, error?.code ?? '')
export const communicationFailure = error => knownCommunicationFailure(error)
  ? t(descriptions[error.code]) + ` [${error.code}]`
  : t('The action could not be confirmed. Refresh status before trying again.')

// Only explicit precondition/authorization rejections release an intent ID.
const definitive = new Set(['INSTANCE_AUTHENTICATION_REQUIRED','AMBIGUOUS_MENTION','UNKNOWN_MENTION','PAYLOAD_TOO_LARGE','UNSUPPORTED_CONTENT',
  'NOT_A_MEMBER','MEMBERSHIP_REVOKED','FORBIDDEN','INVALID_REPLY_TARGET','REFERENCE_NOT_AVAILABLE','SPEAKING_FORBIDDEN','PASSIVE_REPLY_REQUIRED',
  'PASSIVE_REPLY_ONLY','GROUP_VERSION_CONFLICT','OWNER_TRANSFER_REQUIRED','OWNER_RECLAIM_REQUIRED','INVALID_REQUEST','INVALID_OPERATION',
  'UNAUTHENTICATED','PEER_REVOKED','MEMBERSHIP_LIMIT','BOT_NOT_PUBLISHED','CONTACT_REQUIRED','UNKNOWN_PRINCIPAL','OPERATION_ID_CONFLICT'])
export const operationOutcomeUncertain = error => !definitive.has(error?.code)
