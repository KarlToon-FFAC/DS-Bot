import metadata from '../../package.json' with { type: 'json' }

export const COMMUNICATION_VERSION = metadata.version
export const displayCommunicationVersion = version => /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(version ?? '') ? `V${version}` : version
const incompatibilities = new Set(['UNSUPPORTED_CAPABILITY', 'PROTOCOL_VERSION_UNSUPPORTED', 'EXPLICIT_ACTIVATION_REQUIRED',
  'BOUNDED_COLLABORATION_REQUIRED', 'BOT_PUBLICATION_MIGRATION_REQUIRED', 'PROACTIVE_ROOT_CAPABILITY_REQUIRED', 'SCHEMA_VERSION_UNSUPPORTED'])
export const incompatibleCommunication = code => incompatibilities.has(code)
export function communicationCompatibility(welcome, code) {
  const supplied = welcome?.communicationVersion
  const value = typeof supplied === 'string' ? supplied.replace(/^[vV](?=\d)/, '') : supplied
  const hubVersion = typeof value === 'string' && /^[0-9][a-zA-Z0-9._+-]{0,63}$/.test(value) ? value : null
  return { clientVersion: COMMUNICATION_VERSION, hubVersion,
    status: incompatibleCommunication(code) ? 'incompatible' : !hubVersion ? 'unknown' : hubVersion === COMMUNICATION_VERSION ? 'matched' : 'different',
    ...(incompatibleCommunication(code) ? { code } : {}) }
}
