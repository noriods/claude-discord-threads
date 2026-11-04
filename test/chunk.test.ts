/**
 * Reply splitting. Each case is a way a split reply used to look broken in
 * Discord: a code block cut in half, a tiny orphan part, a section cut
 * mid-list, or a very long answer arriving as a wall of messages.
 */

import { test, expect } from 'bun:test'
import { chunk } from '../src/discord/util'
import { asFileReply } from '../src/discord/threads'

const fences = (s: string) => s.split('\n').filter(l => l.trim().startsWith('```')).length

test('short text is one part', () => {
  expect(chunk('hi', 2000, 'newline')).toEqual(['hi'])
})

test('every part fits the limit', () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(i % 40)}`).join('\n')
  for (const p of chunk(text, 2000, 'newline')) expect(p.length).toBeLessThanOrEqual(2000)
})

test('a code block cut in half is closed and reopened', () => {
  const code = Array.from({ length: 120 }, (_, i) => `const v${i} = ${i} // padding padding`).join('\n')
  const parts = chunk(`Intro.\n\n\`\`\`ts\n${code}\n\`\`\`\n\nDone.`, 2000, 'newline')
  expect(parts.length).toBeGreaterThan(1)
  for (const p of parts) expect(fences(p) % 2).toBe(0)
  expect(parts[1]!.startsWith('```ts\n')).toBe(true)
})

test('parts are even, not 1990 + a tiny orphan', () => {
  const text = Array.from({ length: 82 }, (_, i) => `sentence number ${i} here.`).join('\n')
  expect(text.length).toBeGreaterThan(2000)
  const parts = chunk(text, 2000, 'newline')
  expect(parts.length).toBe(2)
  expect(Math.abs(parts[0]!.length - parts[1]!.length)).toBeLessThan(200)
})

test('cuts before a heading rather than inside its section', () => {
  const section = (h: string) => `### ${h}\n` + Array.from({ length: 25 }, (_, i) => `- item ${i} of ${h}`).join('\n')
  const text = [section('One'), section('Two'), section('Three'), section('Four'), section('Five')].join('\n\n')
  const parts = chunk(text, 2000, 'newline')
  expect(parts.length).toBe(2)
  expect(parts[1]!.startsWith('### ')).toBe(true)
})

test('length mode still slices exactly', () => {
  expect(chunk('abcdef', 4, 'length')).toEqual(['abcd', 'ef'])
})

test('a long reply becomes lead + reply.md, footer kept in the message', () => {
  const body = 'First paragraph.\n\n' + 'more words here. '.repeat(400)
  const footer = '\n\n-# 📅 ▰▰▱▱ 20%'
  const r = asFileReply(body + footer, [], 2000)!
  expect(r.content).toStartWith('First paragraph.')
  expect(r.content).toEndWith('-# 📅 ▰▰▱▱ 20%')
  const file = r.files[0] as { attachment: Buffer; name: string }
  expect(file.name).toBe('reply.md')
  expect(file.attachment.toString()).toBe(body.trim())
})

test('normal-length replies are not turned into files', () => {
  expect(asFileReply('x'.repeat(3000), [], 2000)).toBeNull()
})

test('a tiny limit with a fence still finishes', () => {
  const parts = chunk('```ts\n' + 'x'.repeat(50) + '\n```', 10, 'newline')
  expect(parts.join('')).toContain('x'.repeat(10))
  const mid = chunk('```ts\n' + 'abc def\n'.repeat(30) + '```', 60, 'newline')
  for (const p of mid) expect(p.length).toBeLessThanOrEqual(60)
})

test('a huge footer falls back to splitting instead of hanging', () => {
  const text = 'word '.repeat(1000) + '\n\n' + Array.from({ length: 60 }, () => '-# ' + 'f'.repeat(30)).join('\n')
  expect(asFileReply(text, [], 2000)).toBeNull()
})

test('a preview that stops inside a code block is closed', () => {
  const text = '```sh\necho one\n\necho two\n```\n\n' + 'more words here. '.repeat(400)
  const r = asFileReply(text, [], 2000)!
  expect(fences(r.content) % 2).toBe(0)
})
