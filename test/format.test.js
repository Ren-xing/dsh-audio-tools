import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatBitrate, formatBytes, formatClock, formatDuration, formatSrtTimestamp, parseTime,
} from '../lib/format.js'

test('parseTime accepts seconds, mm:ss and hh:mm:ss', () => {
  assert.equal(parseTime(12.5), 12.5)
  assert.equal(parseTime('90'), 90)
  assert.equal(parseTime('01:30'), 90)
  assert.equal(parseTime('1:02:03.5'), 3723.5)
  assert.equal(parseTime(0), 0)
})

test('parseTime rejects malformed or impossible times', () => {
  assert.throws(() => parseTime('1:75'), /minutes must be < 60/)
  assert.throws(() => parseTime('00:00:75'), /seconds < 60/)
  assert.throws(() => parseTime('abc'), /invalid time/)
  assert.throws(() => parseTime(-1), /negative/)
  assert.throws(() => parseTime(''), /invalid time/)
})

test('parseTime names the argument in its error', () => {
  assert.throws(() => parseTime('x', 'start'), /invalid start/)
})

test('formatClock pads to hh:mm:ss.mmm', () => {
  assert.equal(formatClock(0), '00:00:00.000')
  assert.equal(formatClock(3723.5), '01:02:03.500')
  assert.equal(formatClock(59.999), '00:00:59.999')
})

test('formatSrtTimestamp uses a comma', () => {
  assert.equal(formatSrtTimestamp(3723.5), '01:02:03,500')
})

test('formatBytes switches units', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatBytes(2.5 * 1024 ** 3), '2.5 GB')
})

test('formatDuration is compact and readable', () => {
  assert.equal(formatDuration(3.2), '3.2s')
  assert.equal(formatDuration(62), '1m 02s')
  assert.equal(formatDuration(3723), '1h 02m 03s')
})

test('formatBitrate never prints NaN', () => {
  assert.equal(formatBitrate(192), '192 kbps')
  assert.equal(formatBitrate(0), '?')
  assert.equal(formatBitrate(null), '?')
})
