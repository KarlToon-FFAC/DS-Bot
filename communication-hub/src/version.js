import metadata from '../package.json' with { type: 'json' }

export const COMMUNICATION_VERSION = metadata.version

export const COMMUNICATION_DISPLAY_VERSION = `V${COMMUNICATION_VERSION.replace(/-T(\d+)$/, 'T$1')}`
