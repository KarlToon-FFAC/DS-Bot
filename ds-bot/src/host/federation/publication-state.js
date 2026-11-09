const scopeKeys = ['hubId', 'url', 'instanceId', 'credentialKey', 'credentialEnv']
export const publicationKeys = ['publishedBotIds', 'publicationGenerations']
const scope = value => JSON.stringify(scopeKeys.map(key => value?.[key]))
const values = value => JSON.stringify([ [...(value?.publishedBotIds ?? [])].sort(), Object.entries(value?.publicationGenerations ?? {}).sort(([a],[b]) => a.localeCompare(b)) ])

// ConfigEditor may save without updating this plugin instance's in-memory options.
export function recordPublicationSave(rt, settings) {
  rt.pendingCommunicationPublication = { ...Object.fromEntries(scopeKeys.map(key => [key, settings[key]])),
    publishedBotIds: [...settings.publishedBotIds], ...(settings.publicationGenerations === undefined ? {} : { publicationGenerations: { ...settings.publicationGenerations } }) }
}
export function pendingPublication(rt, applied) {
  const pending = rt.pendingCommunicationPublication
  return pending && scope(pending) === scope(applied) && scope(rt.config.communication) === scope(applied)
    && values(pending) !== values(applied) ? pending : null
}
export function publicationReloadRequired(rt, applied) {
  return Boolean(pendingPublication(rt, applied) || scope(rt.config.communication) === scope(applied) && values(rt.config.communication) !== values(applied))
}
