// ConfigEditor reports some public rejections as plain Errors without a code.
// Match only its exact diagnostics; never return raw paths or exception text.
export function configFailureCode(cause) {
  const message = typeof cause?.message === 'string' ? cause.message : ''
  if (/^Configuration for "[^"\r\n]+" is overridden by a home patch or command-line overlay$/.test(message)) return 'CONFIG_EDIT_OVERLAID'
  if (['Configuration entry is no longer available', 'Configuration entry changed during reload'].includes(message)) return 'CONFIG_EDIT_ENTRY_CHANGED'
  if (message === 'Configuration plugin is no longer active') return 'CONFIG_EDIT_NOT_ACTIVE'
  if (message === 'Profile patch must be a YAML sequence') return 'CONFIG_EDIT_INVALID_DOCUMENT'
  return 'COMMUNICATION_CONFIG_WRITE_FAILED'
}
