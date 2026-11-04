import { test, expect } from 'bun:test'
import { wrap } from '../src/discord/util'

test('wraps prose, keeps code, headings, URLs and list indents', () => {
  const long = 'word '.repeat(30).trim()
  const url = 'https://example.com/' + 'x'.repeat(100)
  const out = wrap(`## ${long}\n${long}\n- ${long}\n> ${long}\n\`\`\`\n${long}\n\`\`\`\nsee ${url}`)
  const lines = out.split('\n')
  expect(lines[0]).toBe(`## ${long}`)
  for (const l of lines.filter(l => !l.startsWith('##') && l !== long && !l.includes('https'))) expect(l.length).toBeLessThanOrEqual(80)
  expect(out).toContain('```\n' + long + '\n```')
  expect(out).toContain('- word word')
  expect(out).toMatch(/\n  word/)
  expect(out).toMatch(/\n> word/)
  expect(out).toContain(url)
})
