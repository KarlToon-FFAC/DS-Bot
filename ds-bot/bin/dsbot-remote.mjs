#!/usr/bin/env node
import { communicationError } from '../src/shared/communication-diagnostics.js'
import { COMMUNICATION_VERSION, displayCommunicationVersion } from '../src/shared/communication-version.js'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { normalizeAttachments } from '../src/shared/communication-attachments.js'

const text = 'string', integer = 'integer'
const schemas = {
  'remote-hub-settings': {},
  'set-remote-hub-enabled': {enabled:'boolean',expectedVersion:text,confirmHideAllBots:'boolean'},
  state: {}, diagnose: {}, contacts: {}, conversations: {}, invites: {}, outbox: {},
  'routing-audit': {limit:integer},
  members: { conversationId: text },
  thread: { conversationId: text, messageId: text, after: integer, limit: integer, watermark: integer, membershipEpoch: text },
  'search-history':{query:text,conversationId:text,membershipEpoch:text,cursor:text,limit:integer},
  history: { conversationId: text, after: integer, before: integer, limit: integer, latest: 'boolean', membershipEpoch: text },
  reference: { conversationId: text, messageId: text }, read: { conversationId: text, seq: integer, membershipEpoch:text },
  send: { conversationId: text, text: 'message-text', attachments:'attachments', messageId: text, clientCreatedAt: text, membershipEpoch: text, mentions: 'strings', replyToMessageId: text },
  dm: { otherPrincipalId: text, operationId: text },
  'create-group': { title: text, operationId: text },
  invite: { conversationId: text, inviteePrincipalId: text, membershipEpoch: text, expectedVersion: integer, operationId: text },
  accept: { inviteId: text, recipientPrincipalId: text, operationId: text },
  remove: { conversationId: text, targetPrincipalId: text, membershipEpoch: text, expectedVersion: integer, operationId: text },
  leave: { conversationId: text, membershipEpoch: text, expectedVersion: integer, operationId: text },
  routing: { conversationId: text, mode: ['admin', 'mentionsOnly'], adminBotPrincipalId: text, defaultBotPrincipalIds: 'strings', membershipEpoch: text, expectedVersion: integer, operationId: text },
  policy: { conversationId: text, targetPrincipalId: text, role: ['member', 'admin'], speakingMode: ['readOnly', 'speak', 'passive', 'active'], membershipEpoch: text, expectedVersion: integer, operationId: text },
  transfer: { conversationId: text, targetPrincipalId: text, expectedVersion: integer, membershipEpoch: text, operationId: text },
  dissolve: { conversationId: text, operationId: text },
  'configure-group': { conversationId: text, title: text, expectedVersion: integer, membershipEpoch: text, operationId: text },
  'save-settings': { conversationId: text, expectedVersion: integer, membershipEpoch: text, operationId: text, title: text,
    routing: { fields: { mode: ['admin', 'mentionsOnly'], adminBotPrincipalId: text, defaultBotPrincipalIds: 'strings' }, required: ['mode'] },
    policies: { items: { fields: { targetPrincipalId: text, role: ['member', 'admin'], speakingMode: ['readOnly', 'speak', 'passive', 'active'] },
      required: ['targetPrincipalId'], someRequired: ['role', 'speakingMode'] } } },
  'rename-human': { displayName: text },
  'profile-human': { displayName: text, avatar: { nullable: true, fields: { image: 'avatarImage' }, required: ['image'] }, operationId: text },
  avatar: { principalId: text, revision: 'sha256' },
  'decode-hub-code': { hubCode: text },
  'join-hub': { hubCode: text, displayName: text, confirmedHubId: text, confirmedUrl: text, confirmedTrustFingerprint: text },
  'update-hub-trust': { hubCode: text, confirmedHubId: text, confirmedUrl: text, confirmedTrustFingerprint: text },
  'disconnect-hub': { hubId:text,confirmedUrl:text },
  'leave-hub':{hubId:text,confirmedUrl:text,confirmLeave:'boolean'},
  'hub-leave-status':{hubId:text,confirmedUrl:text},
  'forget-hub':{hubId:text,confirmedUrl:text,confirmForget:'boolean',force:'boolean',expectedIdentity:text,expectedRequestId:text,deleteLocalHistory:'boolean',confirmDeleteLocalHistory:'boolean'},
  'switch-hub': { hubId:text,hubCode:text,displayName:text,expectedCurrentHubId:text,confirmedHubId:text,confirmedUrl:text,confirmedTrustFingerprint:text },
  'resume-hub': { hubId:text,confirmedUrl:text,confirmResume:'boolean' },
  'onboarding-storage': { hubId: text },
  'hub-join-status': { hubId: text }, 'cancel-hub-join': { hubId: text },
  'bot-dm-history': {conversationId:text,localBotId:text,membershipEpoch:text,after:integer,before:integer,limit:integer,latest:'boolean'},
  'bot-dm-read': {conversationId:text,localBotId:text,membershipEpoch:text,seq:integer},
  'bot-dm-reference': {conversationId:text,localBotId:text,membershipEpoch:text,messageId:text},
  'answer-work-approval': {id:text,choice:['allow','reject'],expectedScope:text},
  'set-conversation-archived': {conversationId:text,membershipEpoch:text,localBotId:text,archived:'boolean',expectedScope:text},
  'participant-profile': {conversationId:text,membershipEpoch:text,targetPrincipalId:text,localBotId:text},
  'user-code': {}, 'rotate-user-code': { operationId: text },
  'request-contact': { userCode: text, localBotIds: 'strings', operationId: text },
  'contact-requests': {}, 'contact-relations': {},
  'accept-contact': { requestId: text, expectedVersion: integer, localBotIds: 'strings', operationId: text },
  'reject-contact': { requestId: text, expectedVersion: integer, localBotIds: 'strings', operationId: text },
  'cancel-contact': { requestId: text, expectedVersion: integer, localBotIds: 'strings', operationId: text },
  'use-published-contact-bots': { otherHumanPrincipalId: text, expectedVersion: integer, operationId: text },
  'revoke-contact': { otherHumanPrincipalId: text, expectedVersion: integer, operationId: text },
  'work-approval-settings': {}, 'set-work-approval': {remoteWorkApproval:['inherit','ask']},
  'available-bots': {}, 'publish-bots': { localBotIds: 'strings', expectedPublishedBotIds: 'strings' },
  'relationship-memory': { localBotId: text, conversationId: text, membershipEpoch: text },
  'save-relationship-memory': { localBotId: text, conversationId: text, membershipEpoch: text, subjectKind: ['self','contact','group'], subjectPrincipalId: text,
    topic: ['identity','organization','expertise','collaboration-role','purpose','collaboration-guidance'], text, shareAcrossConversations: 'boolean' },
  'forget-relationship-memory': { localBotId: text, conversationId: text, membershipEpoch: text, id: 'sha256' },
}
const required = {
  'set-remote-hub-enabled':['enabled','expectedVersion'],
  'set-work-approval':['remoteWorkApproval'],
  'bot-dm-history':['conversationId','localBotId','membershipEpoch'],
  'bot-dm-read':['conversationId','localBotId','membershipEpoch','seq'],
  'bot-dm-reference':['conversationId','localBotId','membershipEpoch','messageId'],
  'answer-work-approval':['id','choice','expectedScope'],
  'set-conversation-archived':['conversationId','membershipEpoch','archived','expectedScope'],
  'participant-profile':['conversationId','membershipEpoch','targetPrincipalId'],
  thread: ['conversationId', 'messageId'],
  'search-history':['query'],
  members: ['conversationId'], history: ['conversationId'], reference: ['conversationId', 'messageId'], read: ['conversationId', 'seq'],
  send: ['conversationId', 'text'], dm: ['otherPrincipalId'], 'create-group': ['title'], invite: ['conversationId', 'inviteePrincipalId'],
  accept: ['inviteId'], remove: ['conversationId'], leave: ['conversationId'], routing: ['conversationId', 'mode'],
  policy: ['conversationId', 'targetPrincipalId', 'expectedVersion'], transfer: ['conversationId', 'targetPrincipalId', 'expectedVersion'],
  dissolve: ['conversationId'], 'configure-group': ['conversationId', 'title', 'expectedVersion'], 'rename-human': ['displayName'],
  'save-settings': ['conversationId', 'expectedVersion'],
  avatar: ['principalId', 'revision'],
  'update-hub-trust': ['hubCode','confirmedHubId','confirmedUrl','confirmedTrustFingerprint'], 'decode-hub-code': ['hubCode'], 'join-hub': ['hubCode', 'displayName', 'confirmedHubId', 'confirmedUrl'],
  'hub-join-status': ['hubId'], 'cancel-hub-join': ['hubId'], 'request-contact': ['userCode'],
  'accept-contact': ['requestId', 'expectedVersion'], 'reject-contact': ['requestId', 'expectedVersion'],
  'cancel-contact': ['requestId', 'expectedVersion'], 'revoke-contact': ['otherHumanPrincipalId', 'expectedVersion'],
  'use-published-contact-bots': ['otherHumanPrincipalId', 'expectedVersion'],
  'publish-bots': ['localBotIds'],
  'relationship-memory': ['localBotId'], 'save-relationship-memory': ['localBotId','subjectKind','topic','text'], 'forget-relationship-memory': ['localBotId','id'],
  'switch-hub':['confirmedHubId','confirmedUrl'], 'resume-hub':['confirmedUrl','confirmResume'],
  'leave-hub':['hubId','confirmedUrl','confirmLeave'], 'hub-leave-status':['hubId','confirmedUrl'],
  'forget-hub':['hubId','confirmedUrl','confirmForget','deleteLocalHistory'],
}
const projections = new Set(['contacts', 'conversations', 'invites', 'outbox'])
const fail = (code, exitCode = 2, request, publicError) => { throw Object.assign(new Error(code), { code, exitCode, request, publicError }) }
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const validValue = (type, value) => {
  if(type === 'message-text')return typeof value==='string'
  if(type === 'attachments'){try{normalizeAttachments(value);return true}catch{return false}}
  if (Array.isArray(type)) return type.includes(value)
  if (type && typeof type === 'object') {
    if (type.nullable && value === null) return true
    if (type.items) return Array.isArray(value) && value.every(item => validValue(type.items, item))
    return object(value) && Object.entries(value).every(([key, item]) => Object.hasOwn(type.fields, key) && validValue(type.fields[key], item))
      && (type.required ?? []).every(key => value[key] !== undefined)
      && (!type.someRequired || type.someRequired.some(key => value[key] !== undefined))
  }
  if (type === integer) return Number.isSafeInteger(value) && value >= 0
  if (type === 'strings') return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0)
  if (type === 'sha256') return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (type === 'avatarImage') {
    if (typeof value !== 'string' || value.length > 160000) return false
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
    if (!match || match[2].length % 4 !== 0) return false
    const bytes = Buffer.from(match[2], 'base64')
    if (bytes.toString('base64') !== match[2]) return false
    return match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : match[1] === 'jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : match[1] === 'gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
      : bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  }
  return typeof value === type && (type !== text || value.trim().length > 0)
}

export const pairingGuide = {
  title: 'Add a machine to Remote communication',
  mode: 'Instructions and non-secret templates only. No network request, credential generation or configuration change.',
  requirements: ['Node 24 or newer; same compatible DS Bot version on Hub and clients',
    'An existing Hub reachable by the clients with a trusted WSS certificate matching its hostname',
    'Hub owner authorization; use the code-join flow below when supported, or the static peer templates as a manual fallback'],
  codeJoin: [
    'Hub owner: configure trusted HTTPS/WSS and use the Human-only Hub admin portal to obtain a Hub code and approve device enrollment.',
    'New machine: decode-hub-code {hubCode} through your authenticated local API. Review the decoded Hub ID and URL with the user before join-hub {hubCode,displayName,confirmedHubId,confirmedUrl}. Never infer an address or approve a different Hub.',
    'Read hub-join-status {hubId} and onboarding-storage {hubId}. The local Host SDK persists pending credentials and enrollment; the CLI never reads keys or credential records. After an uncertain join, reconcile this state before an explicit retry. Use cancel-hub-join {hubId} to cancel.',
    'After approval and connection, use available-bots and publish-bots {localBotIds:[]} to choose publication explicitly. Honor reloadRequired and recheck connected state.',
    'Optional local work confirmation: work-approval-settings reads the policy; set-work-approval {remoteWorkApproval:"ask"} confirms each remote file mutation/Shell call, while inherit uses the Bot policy. Grants are one call and do not expand the sandbox. Wait for reload after saving.',
    'For localBotId, use the exact id from available-bots, not a global bot: principal ID or another chat/session ID. After publish-bots, wait until state.reloadRequired is false and connected/reconciled are true before Bot-scoped operations. Refresh memberships after identity changes.',
    'Exchange user-code privately, then request-contact {userCode}. Omitted or empty localBotIds follows published Bots; a nonempty list deliberately narrows the scope. Invalid or rotated codes fail without creating a request. User codes remain reusable until rotated. A successful request is pending the other Human’s decision, not accepted.',
    'Inspect contact-requests/contact-relations and exact contacts; confirm both Humans and only the Bots explicitly shared by each side. Group membership and speaking grants remain separate.',
  ],
  steps: [
    'Hub owner: privately provision a distinct high-entropy pairing secret of at least 32 characters for the new instance. This is not a model API key or DSH login cookie.',
    'Hub owner: preserve all existing peers; add the peer template to the explicit Hub JSON peers list, inject its credential into the named environment variable, then restart the Hub with that same complete configuration. Removing an existing peer revokes it.',
    'New machine: create a separate local DS Bot profile/team; quit the app completely before editing that profile. Do not copy another machine\'s profile, database or credentials.',
    'New machine: merge clientCommunication into the existing id: bot config.communication row; choose its own local Bot IDs for explicit publication. Supply the matching pairing secret only in the private client launch environment under credentialEnv, then start that profile.',
    'Use a WSS hostname matching its certificate. Prefer a signed v2 Hub code: the client validates and stores public CA trust for that exact Hub and URL, with no client CA environment setup. Legacy clients and TLS-intercepting proxies need separate administrator review. Never disable TLS verification or use non-loopback plaintext ws.',
    'Each new instance has one Human; publishedBotIds selects only explicit local Bots. Human display names/IP headings do not merge identities or grant rights.',
    'Both machines: check the Remote communication panel or authenticated CLI state/contacts. Confirm connected/reconciled and four exact distinct principals for A Human, A published Bot, B Human and B published Bot. A health response alone does not prove pairing.',
    'Test synthetic DMs in all Human/Bot directions, then create a group, invite exact principals and explicitly accept. A Human DM does not activate that Human\'s private Chief. Invitees start readOnly/passive; assign speaking permissions explicitly.',
    'If revoked, reconnect is insufficient: Hub owner must intentionally increase pairingRevision. Group ownership is not restored after revocation; ordinary members need fresh invitations.',
  ],
  hubPeerToAppend: { instanceId: 'new-machine', instanceLabel: 'New machine', pairingRevision: 1, credentialEnv: 'DSBOT_HUB_NEW_MACHINE_CREDENTIAL' },
  hubTransportExample: { host: '0.0.0.0', port: 3190, databasePath: './hub.sqlite', tls: { certificateEnv: 'DSBOT_TLS_CERT', privateKeyEnv: 'DSBOT_TLS_KEY' } },
  clientCommunication: { enabled: true, instanceId: 'new-machine', url: 'wss://YOUR_TRUSTED_HUB:3190/communication', credentialEnv: 'DSBOT_COMMUNICATION_CREDENTIAL', humanDisplayName: 'New person', publishedBotIds: ['REPLACE_WITH_LOCAL_BOT_ID'] },
  sourceTrialProfileExample: '.ds-bot-local/trial/data/profiles/ds-bot/cordis.patch.yml (for start.ps1 -DataRoot .ds-bot-local/trial only; use your actual selected profile otherwise)',
  commands: { hub: 'npm start --prefix communication-hub -- ./local/hub.json', sourceClient: './start.ps1 -DataRoot .ds-bot-local/trial', verify: 'dsbot-remote state; dsbot-remote contacts (authentication supplied privately)' },
  recovery: 'Do not delete/copy communication.sqlite, silently reuse another instanceId or lower pairingRevision. Inspect sanitized state errors. Wrong credentials, untrusted certificates, unreachable endpoints and revoked peers need their respective owner to correct them.',
}

export function prepare(operation, input = {}) {
  if (operation === 'retry') {
    if (!object(input) || typeof input.endpoint !== 'string') fail('RETRY_REQUIRES_ORIGINAL_REQUEST')
    operation = input.endpoint
    input = { ...input }; delete input.endpoint
    if (operation === 'send' && (!input.messageId || !input.clientCreatedAt) || schemas[operation]?.operationId && !input.operationId) fail('RETRY_REQUIRES_ORIGINAL_ID')
  }
  if (!Object.hasOwn(schemas, operation) || !object(input)) fail('INVALID_OPERATION_OR_INPUT')
  const schema = schemas[operation]
  for (const [key, value] of Object.entries(input)) {
    const type = schema[key]
    if (!Object.hasOwn(schema, key) || !validValue(type, value)) fail('INVALID_FIELD_' + key.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40))
  }
  if ((required[operation] ?? []).some(key => input[key] === undefined)) fail('MISSING_REQUIRED_FIELD')
  if (operation === 'policy' && input.role === undefined && input.speakingMode === undefined) fail('POLICY_CHANGE_REQUIRED')
  if (operation === 'profile-human' && input.displayName === undefined && input.avatar === undefined) fail('PROFILE_CHANGE_REQUIRED')
  if (operation === 'profile-human' && input.displayName?.trim().length > 256) fail('INVALID_FIELD_displayName')
  if (operation === 'join-hub' && input.displayName.length > 100) fail('INVALID_FIELD_displayName')
  if (input.localBotIds && (input.localBotIds.length > 100 || new Set(input.localBotIds).size !== input.localBotIds.length)) fail('INVALID_FIELD_localBotIds')
  if (operation === 'request-contact' && input.userCode.length > 4096) fail('INVALID_FIELD_userCode')
  if (operation === 'save-settings') {
    if (input.title === undefined && input.routing === undefined && !input.policies?.length) fail('SETTINGS_CHANGE_REQUIRED')
    const targets = input.policies?.map(item => item.targetPrincipalId) ?? []
    if (new Set(targets).size !== targets.length) fail('DUPLICATE_POLICY_TARGET')
  }
  if (operation === 'history' && input.limit !== undefined && (input.limit < 1 || input.limit > 200)) fail('INVALID_HISTORY_LIMIT')
  if (operation === 'send' && input.clientCreatedAt !== undefined && !Number.isFinite(Date.parse(input.clientCreatedAt))) fail('INVALID_TIMESTAMP')
  const request = { ...input, endpoint: projections.has(operation) ? 'state' : operation === 'leave' ? 'remove' : operation }
  if (projections.has(operation)) delete request.conversationId
  if (schema.operationId && request.operationId === undefined) request.operationId = randomUUID()
  if (operation === 'send') {
    request.messageId ??= randomUUID()
    request.clientCreatedAt ??= new Date().toISOString()
  }
  return { operation, request, input }
}

const fieldDescriptions = {
  defaultBotPrincipalIds: 'Exact current published group Bot principal IDs. In admin mode, all selected Bots receive unmentioned Human messages; explicit mentions/replies override this default. Multiple Bots require Hub capability multi-bot-default-receivers. Do not supply the legacy singleton field together with a multi-selection.',
  localBotId: 'Exact native Bot id from available-bots.bots[].id, often session-<id>. Not a global bot:<instance>:<id>, a name, or another/current remote Session id.',
  localBotIds: 'Native Bot ids from available-bots.bots[].id (often session-<id>); never global bot:<instance>:<id> principal ids. A successful publication save reports reloadReason:publication and publicationStatus:saved-pending-reload. Wait for state.reloadRequired=false and current membership before Bot-scoped operations; pending calls return PUBLICATION_RELOAD_REQUIRED.',
  mentions: 'CLI/API accepts an array of exact principal-id strings. The host normalizes these to protocol {principalId} objects and validates current conversation membership, including group members outside your contact directory.',
}
const describeOperation = (name, fields) => ({ fields, required: required[name] ?? [],
  fieldDescriptions: Object.fromEntries(Object.keys(fields).filter(key => fieldDescriptions[key]).map(key => [key, fieldDescriptions[key]])) })

export const help = operation => JSON.stringify({
  name: 'dsbot-remote', version: displayCommunicationVersion(COMMUNICATION_VERSION), usage: 'dsbot-remote <operation> [--json] [--config <explicit-file>] < request.json',
  authentication: 'DSBOT_REMOTE_URL and DSBOT_REMOTE_COOKIE, or explicit --config JSON {url,cookie}. Local loopback only; no discovery. Never put a cookie in argv.',
  operations: operation && schemas[operation] ? { [operation]: describeOperation(operation, schemas[operation]) }
    : Object.fromEntries(Object.entries(schemas).map(([name, fields]) => [name, describeOperation(name, fields)])),
  retry: 'dsbot-remote retry < original-request.json; use the request object from the previous result/error unchanged. No automatic retries for uncertain outcomes. A definite local reset-generation rejection is reconciled once with the same request IDs.',
  settings: 'save-settings atomically validates/applies title, routing and member policies against one expectedVersion and increments the group version once. No partial save; retry the complete original request with its original operationId.',
  profile: 'profile-human changes only the authenticated Human. avatar:null resets to a name-derived avatar; avatar:{image:dataURL} uses a consenting custom PNG/JPEG/WebP/GIF image, max 160000 characters. No URLs or file paths. Preserve the complete original operationId/request for an uncertain retry. Profile requests and avatar reads contain image data: keep them private to the intended audience.',
  enrollment: 'decode-hub-code uses the authenticated local API. Review exact Hub ID/URL and, for signed v2 codes, confirmedTrustFingerprint; join-hub requires those confirmations. Host SDK owns durable keys and pending state. Reconcile hub-join-status/onboarding-storage before retrying uncertain enrollment. Never read credential records or send the local session cookie to the Hub.',
  lifecycle: 'onboarding-storage without hubId always lists saved Hubs and selectedHub without connecting. disconnect-hub pauses locally, retaining identity, trust, membership and data. switch-hub requires expectedCurrentHubId and exact reviewed Hub confirmations; selection stays disabled. resume-hub with confirmResume:true verifies signed login before queued work resumes. leave-hub requires exact hubId/confirmedUrl and confirmLeave:true: revoke server access/memberships, retain history; transfer or dissolve owned open groups first. After an uncertain leave or administrator removal use hub-leave-status, never submit a new join. A later explicit administrator repair can be observed through that signed status, but does not resume automatically. forget-hub requires exact hubId/confirmedUrl, confirmForget:true and explicit deleteLocalHistory boolean; approved devices must have confirmed revocation, pending requests must be cancelled. Explicit force:true with expectedIdentity from onboarding-storage (or the exact expectedRequestId) bypasses these remote-state prerequisites for local cleanup even if the Hub is unavailable; it does not delete the server device or revoke server access. It deletes only that Hub configuration/key/CA trust. Keeping history never binds its queue to a fresh identity. deleteLocalHistory:true additionally requires confirmDeleteLocalHistory:true and removes the scoped remote communication queue/cache, not DSH model-session journals or browser-local drafts. Other Hubs are preserved. Legacy static pairing cannot be guessed into another Hub. No blind retries or server-history hard deletion.',
  attachments:'send accepts attachments [{name,mime,size,sha256,data}] through JSON stdin only: canonical base64, SHA-256 lowercase hex, at most four files and 65536 total binary bytes. text may be empty when files are present. No paths or URLs; only user-authorized bytes. All recipients and Hub must support inline-attachments-v1. history/reference/thread return the same authorized bytes; keep outputs private. Preserve the exact complete send on uncertain results. Do not execute received files.',
  contacts: 'request-contact/accept-contact use published Bots when localBotIds is omitted or empty; nonempty IDs retain a narrower explicit scope. Invalid/retired codes fail without a pending row. Existing empty scopes remain visible; use use-published-contact-bots with otherHumanPrincipalId and current expectedVersion to repair only your own side. Preserve operationId for retry.',
  publication: 'available-bots lists eligible local IDs; publish-bots replaces the explicit publication list (use [] for none). Honor reloadRequired and inspect state after reload. Publication alone is not contact consent or group permission.',
  relationshipMemory: 'relationship-memory/save-relationship-memory/forget-relationship-memory manage only this local Bot and Hub. Supply conversationId and current membershipEpoch for private conversation-scoped records. Omitting conversationId selects a profile; saving requires shareAcrossConversations:true, explicitly allowing this Bot to use the fact in all current/future conversations in this Hub where that contact is a member, including replies. Do not promote group-derived facts without local user approval. Bot tools can only record attributed reported/inferred claims in their exact conversation/epoch. Leadership guidance is prompt-only, never a grant. Forgetting removes the local record, not prior model requests, Session/tool history or published replies. Secrets are refused best-effort, not guaranteed classified.',
  reply: 'send.replyToMessageId can address the referenced current member Bot without @ when there are no explicit Bot mentions. Explicit Bot mentions take precedence; membership, speaking permissions, reply grants and causal budgets still apply.',
  setup: 'dsbot-remote setup-guide (alias pairing-guide): unauthenticated offline pairing steps and non-secret configuration templates',
  skill: fileURLToPath(new URL('../skills/dsbot-remote/SKILL.md', import.meta.url)),
  exitCodes: { 0: 'success/accepted (inspect queued delivery status)', 2: 'usage/input', 3: 'configuration/authentication', 4: 'API rejection', 5: 'uncertain outcome; preserve request ID' },
}, null, 2)

export async function execute(prepared, { url, cookie, fetchImpl = fetch, timeout = 15000, apiPath = '/api/communication' }) {
  let base
  try { base = new URL(url) } catch { fail('INVALID_LOCAL_URL', 3) }
  if (!['http:', 'https:'].includes(base.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.search || base.hash || base.pathname !== '/') fail('LOCAL_ORIGIN_REQUIRED', 3)
  if (typeof cookie !== 'string' || !cookie.trim() || /[\r\n]/.test(cookie)) fail('SESSION_COOKIE_REQUIRED', 3)
  if (!['/api/communication', '/api/bot'].includes(apiPath)) fail('LOCAL_API_REQUIRED', 3)
  const { request, operation } = prepared
  const post = async (body, extraHeaders = {}) => {
    try {
      const response = await fetchImpl(new URL(apiPath, base), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeout),
        headers: { 'content-type': 'application/json', cookie, ...extraHeaders }, body: JSON.stringify(body) })
      if ([401, 403].includes(response.status)) fail('AUTHENTICATION_REJECTED', 3, request)
      if (response.status >= 300 && response.status < 400) fail('REDIRECT_REFUSED', 3, request)
      if (!response.ok) fail('HTTP_FAILURE_UNCERTAIN', 5, request)
      const result = await response.json()
      if (!object(result) || typeof result.ok !== 'boolean' || result.ok && !Object.hasOwn(result, 'value')) fail('INVALID_RESPONSE_UNCERTAIN', 5, request)
      return result
    } catch (error) {
      if (error.exitCode) throw error
      fail('NETWORK_OUTCOME_UNCERTAIN', 5, request)
    }
  }
  let result = await post(request)
  // Node fetch supplies browser-shaped fetch metadata. A generation rejection is
  // definite: the Host has not run the request. Reuse its exact IDs once after
  // reading the authenticated gate, never replay an uncertain network outcome.
  if (apiPath === '/api/communication' && !result.ok && result.error?.code === 'COMMUNICATION_BROWSER_RESET_REQUIRED') {
    const reset = await post({ endpoint: 'reset-status' })
    if (!reset.ok) fail(/^[A-Z][A-Z0-9_]{0,100}$/.test(reset.error?.code ?? '') ? reset.error.code : 'API_REJECTED', 4, request)
    if (reset.value?.pending) fail('COMMUNICATION_RESET_INCOMPLETE', 4, request)
    if (typeof reset.value?.browserEpoch !== 'string' || !/^[0-9a-f-]{36}$/.test(reset.value.browserEpoch)) fail('COMMUNICATION_BROWSER_RESET_REQUIRED', 4, request)
    result = await post(request, { 'x-dsbot-browser-epoch': reset.value.browserEpoch })
  }
  if (!result.ok) {
    const code = /^[A-Z][A-Z0-9_]{0,100}$/.test(result.error?.code ?? '') ? result.error.code : 'API_REJECTED'
    const detail = ['PUBLICATION_RELOAD_REQUIRED','COMMUNICATION_RELOAD_REQUIRED','BOT_NOT_PUBLISHED','UNKNOWN_MENTION'].includes(code)
      ? communicationError({ code, mentionValidation: result.error?.mentionValidation }, { reloadRequired: result.error?.reloadRequired === true }) : undefined
    fail(code, ['CONNECTION_LOST', 'REQUEST_TIMEOUT', 'STORAGE_UNAVAILABLE', 'BACKPRESSURE', 'STALE_CONNECTION'].includes(code) ? 5 : 4, request, detail)
  }
  let value = result.value
  if (projections.has(operation)) {
    value = value?.[operation] ?? []
  }
  return { ok: true, value, request }
}

export async function main(argv = process.argv.slice(2), env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr) {
  let cookie
  const write = (stream, value) => {
    let encoded = JSON.stringify(value)
    if (cookie) encoded = encoded.split(JSON.stringify(cookie).slice(1, -1)).join('[REDACTED]')
    stream.write(encoded + '\n')
  }
  try {
    const [operation, ...args] = argv
    if (!operation || operation === '--help' || operation === 'help' || args.includes('--help')) { stdout.write(help(operation === 'help' ? args[0] : operation) + '\n'); return 0 }
    if (['setup-guide', 'pairing-guide'].includes(operation)) {
      if (args.some(arg => arg !== '--json')) fail('INVALID_ARGUMENT')
      write(stdout, { ok: true, value: pairingGuide })
      return 0
    }
    let config = {}
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json') continue
      if (args[i] !== '--config' || !args[i + 1]) fail('INVALID_ARGUMENT')
      try { config = JSON.parse(await readFile(args[++i], 'utf8')) } catch { fail('INVALID_EXPLICIT_CONFIG', 3) }
      if (!object(config) || Object.keys(config).some(key => !['url', 'cookie'].includes(key))) fail('INVALID_EXPLICIT_CONFIG', 3)
    }
    cookie = env.DSBOT_REMOTE_COOKIE ?? config.cookie
    let source = ''
    if (!stdin.isTTY) for await (const chunk of stdin) { source += chunk; if (source.length > 1024 * 1024) fail('INPUT_TOO_LARGE') }
    let input
    try { input = source.trim() ? JSON.parse(source) : {} } catch { fail('INVALID_JSON') }
    write(stdout, await execute(prepare(operation, input), { url: env.DSBOT_REMOTE_URL ?? config.url, cookie }))
    return 0
  } catch (error) {
    write(stderr, { ok: false, error: { code: error.code ?? 'CLI_FAILURE', ...error.publicError }, ...(error.request ? { request: error.request } : {}) })
    return error.exitCode ?? 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main()
