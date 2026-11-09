export function remoteHubConfigured(config) {
  const hub = config?.communication
  return Boolean(hub?.url && (hub.enabled === true || hub.instanceId || hub.credentialKey))
}
export function remoteHubEnabled(config) {
  return config?.remoteHubEnabled === undefined ? config?.communication?.enabled === true || remoteHubConfigured(config) : config.remoteHubEnabled === true
}
export const remoteHubVisible = roster => roster?.remoteHubEnabled ?? roster?.communicationEnabled === true
