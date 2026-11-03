import { HubStore } from '../../src/store.js'

// Ordinary tests model a client capturing its authorization when creating intent.
// Security regressions use the unwrapped store to exercise missing/stale scope.
export class ScopedStore extends HubStore {
  constructor(...args) {
    super(...args)
    for (const name of ['publish','invite','remove','routing','dissolve','policy','transfer']) {
      const original = this[name].bind(this)
      this[name] = (auth, input) => {
        const actor = name === 'publish' ? input.author.principalId : input.principalId
        if (!Object.hasOwn(input, 'membershipEpoch')) {
          const row = this.db.prepare('SELECT epoch FROM memberships WHERE conversation_id=? AND principal_id=?').get(input.conversationId, actor)
          input.membershipEpoch = row?.epoch ?? 'no-membership'
        }
        return original(auth, input)
      }
    }
  }
}
