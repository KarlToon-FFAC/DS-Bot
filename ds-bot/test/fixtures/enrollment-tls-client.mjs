import { connectHubSocket } from '../../src/host/federation/onboarding.js'
let socket, result
try {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined) throw Error('TLS_OVERRIDE_FORBIDDEN')
  socket = await connectHubSocket(process.env.DSBOT_TEST_TLS_URL, { allowLoopback: true, timeoutMs: 3000 })
  result = { connected: true }
} catch (error) { result = { connected: false, code: error.code ?? 'UNKNOWN_TEST_FAILURE' } }
finally { socket?.close() }
process.send(result, () => process.disconnect())
