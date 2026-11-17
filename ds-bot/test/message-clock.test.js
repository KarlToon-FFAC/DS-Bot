import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clockLabel, messageClock } from '../src/client/text.js'

// A time in the machine's own zone, some days back, so the test does not depend on the zone.
const at = (daysAgo, hour, minute) => {
  const today = new Date()
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, hour, minute).getTime()
}
const clockOf = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

test('message stamps include year, month and day today and on earlier dates; separators keep their relative labels', () => {
  for(const time of [at(0,14,5),at(1,9,3),at(5,9,3),new Date(2025,11,31,23,59).getTime()]){
    const date=new Date(time),stamp=messageClock(time)
    assert.ok(stamp.includes(String(date.getFullYear())))
    assert.ok(stamp.startsWith(date.toLocaleDateString('en-US',{year:'numeric',month:'2-digit',day:'2-digit'})))
    assert.ok(stamp.endsWith(clockOf(time)))
    assert.equal(messageClock(date.toISOString()),stamp)
  }
  assert.equal(clockLabel(at(0,14,5)),`Today ${clockOf(at(0,14,5))}`)
  assert.equal(clockLabel(at(1,9,3)),`Yesterday ${clockOf(at(1,9,3))}`)
  assert.equal(messageClock(undefined),'')
  assert.equal(messageClock('invalid'),'')
})
