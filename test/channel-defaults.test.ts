/** A channel in access.json can name a cwd, model and permission mode for its new threads. */
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const STATE = process.env.DISCORD_STATE_DIR ?? mkdtempSync(join(tmpdir(), 'chdef-test-'))
process.env.DISCORD_STATE_DIR = STATE
const { channelDefaults } = await import('../src/discord/access')
const { ACCESS_FILE } = await import('../src/config')

test('channel fields come back; channels without them get nothing', () => {
  if (ACCESS_FILE !== join(STATE, 'access.json')) throw new Error('Refusing to write outside test state')
  writeFileSync(ACCESS_FILE, JSON.stringify({
    dmPolicy: 'allowlist', allowFrom: [], pending: {},
    groups: {
      '1': { requireMention: false, allowFrom: [], cwd: '/b/f', model: 'claude-fable-5-2', permissionMode: 'bypassPermissions' },
      '2': { requireMention: false, allowFrom: [] },
    },
  }))
  expect(channelDefaults('1')).toEqual({ cwd: '/b/f', model: 'claude-fable-5-2', permissionMode: 'bypassPermissions' })
  const plain = channelDefaults('2')
  expect(plain.cwd ?? plain.model ?? plain.permissionMode).toBeUndefined()
  expect(channelDefaults('3')).toEqual({})
})
