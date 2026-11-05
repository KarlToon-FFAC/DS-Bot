// Disposable loopback test only. The public synthetic password is never used in a real Hub.
import { startHub } from '../../../communication-hub/src/server.js'
const peers = JSON.parse(process.env.DSBOT_TEST_PEERS)
delete process.env.DSBOT_TEST_PEERS
const hub = await startHub({ databasePath: process.argv[2], port: Number(process.argv[3]), peers,
  management: { enabled: true, password: 'synthetic-test-instance-name-admin-password' } })
process.on('message', async message => {
  if (message.command === 'close') { await hub.close(); process.exit(0) }
})
process.send?.({ type: 'ready', url: hub.url })
