import metadata from '../../package.json' with { type: 'json' }

export const COMMUNICATION_VERSION = metadata.version
export const displayCommunicationVersion = version => /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(version ?? '') ? `V${version}` : version
const incompatibilities = new Set(['UNSUPPORTED_CAPABILITY', 'PROTOCOL_VERSION_UNSUPPORTED', 'EXPLICIT_ACTIVATION_REQUIRED',
  'BOUNDED_COLLABORATION_REQUIRED', 'BOT_PUBLICATION_MIGRATION_REQUIRED', 'PROACTIVE_ROOT_CAPABILITY_REQUIRED', 'SCHEMA_VERSION_UNSUPPORTED', 'ATTACHMENT_CAPABILITY_REQUIRED'])
export const incompatibleCommunication = code => incompatibilities.has(code)
// Release numbers are presentation metadata; only protocol/capability failures gate a connection.
export function communicationReleaseRelation(client, hub) {
  const parse = value => typeof value === 'string' ? value.match(/^[vV]?(\d+)\.(\d+)\.(\d+)(?:\+[a-zA-Z0-9.-]+)?$/)?.slice(1).map(BigInt) : null
  const a = parse(client), b = parse(hub)
  if (!a || !b) return 'unknown'
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? 'client-older' : 'client-newer'
  return 'same'
}
export function communicationCompatibility(welcome, code) {
  const supplied = welcome?.communicationVersion
  const value = typeof supplied === 'string' ? supplied.replace(/^[vV](?=\d)/, '') : supplied
  const hubVersion = typeof value === 'string' && /^[0-9][a-zA-Z0-9._+-]{0,63}$/.test(value) ? value : null
  return { clientVersion: COMMUNICATION_VERSION, hubVersion,
    releaseRelation: communicationReleaseRelation(COMMUNICATION_VERSION, hubVersion),
    protocol: typeof welcome?.protocol === 'string' && /^dsbot-communication\/\d+$/.test(welcome.protocol) ? welcome.protocol : null,
    updateTarget: incompatibleCommunication(code) && ['client', 'hub', 'both'].includes(welcome?.updateTarget) ? welcome.updateTarget : null,
    status: incompatibleCommunication(code) ? 'incompatible' : !hubVersion ? 'unknown' : hubVersion === COMMUNICATION_VERSION ? 'matched' : 'different',
    ...(incompatibleCommunication(code) ? { code } : {}) }
}
