import { describe, expect, mock, test } from 'bun:test'

// Each call to query() plays the next script: the messages the CLI would stream.
const scripts: Array<unknown[] | ((input: AsyncIterator<unknown>) => AsyncGenerator<unknown>)> = []
const prompts: unknown[] = []
async function readInput(input: AsyncIterator<unknown>) {
  const next = await input.next()
  prompts.push((next.value as { message: { content: unknown } }).message.content)
}
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) =>
    (async function* () {
      const input = prompt[Symbol.asyncIterator]()
      await readInput(input)
      const script = scripts.shift() ?? []
      if (typeof script === 'function') yield* script(input)
      else for (const message of script) yield message
    })(),
}))

const { makeClaudeResponder } = await import('../src/engine/worker')

const tasks = (n: number) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: Array.from({ length: n }, (_, i) => ({ task_id: `t${i}`, task_type: 'local_bash', description: 'tests' })),
})
const result = (text: string) => ({ type: 'result', subtype: 'success', session_id: 's1', result: text })
const usage = (tokens: number) => ({
  type: 'assistant',
  message: { content: [], usage: { input_tokens: 1000, cache_read_input_tokens: tokens - 2000, cache_creation_input_tokens: 1000 } },
})

describe('fresh-thread handoff', () => {
  const ctx = (conversationId: string, content = 'new thread', sessionId: string | null = 's1') => ({
    turn: { content, image_paths: null }, conversationId, sessionId, message: null, cwd: '.',
  })
  const closed = () => new Promise(r => setTimeout(r, 0))

  for (const tokens of [99_999, 100_000, 182_400]) {
    test(`the next resumed prompt uses the ${tokens} token reading`, async () => {
      const respond = makeClaudeResponder()
      const first = ctx(`c-${tokens}`, 'hi', null)
      scripts.push([usage(tokens), result('Answer')])
      const reply = await respond(first as never)
      expect(prompts.at(-1)).toBe('hi')
      expect(reply).toMatchObject({ kind: 'reply', text: 'Answer', usage: { contextTokens: tokens } })
      await closed()

      scripts.push([result('Next answer')])
      const next = ctx(first.conversationId)
      await respond(next as never)
      if (tokens < 100_000) expect(prompts.at(-1)).toBe('new thread')
      else {
        expect(prompts.at(-1)).toBe(`[context: this thread is at ~${Math.round(tokens / 1000)}k tokens. If this message is a new topic, or Norio says "new thread", answer briefly and end with a paste-ready 3–5 line opener for a fresh thread: goal, current state, file/brief, blocker, next action. Otherwise ignore this note.]\n\nnew thread`)
      }
      expect(next.turn.content).toBe('new thread')
      await closed()

      // A different thread and /clear both start without an old reading.
      for (const fresh of [ctx('other', 'hi', null), ctx(first.conversationId, 'hi', null)]) {
        scripts.push([result('Fresh answer')])
        await respond(fresh as never)
        expect(prompts.at(-1)).toBe('hi')
        await closed()
      }
    })
  }

  test('held sessions and steering get the note, then use the latest lower reading', async () => {
    scripts.push(async function* (input) {
      yield usage(100_000)
      yield tasks(1)
      yield result('Answer')
      await readInput(input)
      await readInput(input)
      yield usage(90_000)
      yield tasks(0)
      yield result('Done')
    })
    const respond = makeClaudeResponder()
    await respond(ctx('held', 'hi', null) as never)
    const pending = respond(ctx('held', 'next topic') as never)
    await closed()
    expect(prompts.at(-1)).toStartWith('[context: this thread is at ~100k tokens.')
    expect(prompts.at(-1)).toEndWith('\n\nnext topic')
    expect(respond.steer!('held', 'also this')).toBe(true)
    await pending
    expect(prompts.at(-1)).toEndWith('\n\nalso this')
    expect(prompts.at(-1)).toStartWith('[context: this thread is at ~100k tokens.')
    await closed()
    scripts.push([result('Small again')])
    await respond(ctx('held', 'continue') as never)
    expect(prompts.at(-1)).toBe('continue')
    await closed()
  })

  test('a /compact with no later usage clears the stale reading', async () => {
    const respond = makeClaudeResponder()
    scripts.push([usage(150_000), result('Answer')])
    await respond(ctx('compacted', 'hi', null) as never)
    await closed()
    const boundary = { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 150_000, post_tokens: 20_000 } }
    scripts.push([boundary, result('')])
    await respond(ctx('compacted', '/compact') as never)
    await closed()
    scripts.push([result('Next')])
    await respond(ctx('compacted', 'next topic') as never)
    expect(prompts.at(-1)).toBe('next topic')
    await closed()
  })

  test('command expansion survives the note and /compact stays a CLI command', async () => {
    const { RECAP_PROMPT } = await import('../src/discord/commands')
    const respond = makeClaudeResponder()
    for (const content of ['hi', '/recap', '/compact']) {
      scripts.push([usage(100_000), result('Answer')])
      await respond(ctx('commands', content, content === 'hi' ? null : 's1') as never)
      await closed()
      if (content === '/recap') {
        expect(prompts.at(-1)).toStartWith('[context:')
        expect(prompts.at(-1)).toEndWith(RECAP_PROMPT)
      } else expect(prompts.at(-1)).toBe(content)
    }
  })
})

async function run(lateText: string): Promise<{ reply: string; late: string[] }> {
  scripts.push([tasks(1), result('Answer'), tasks(0), result(lateText)])
  const late: string[] = []
  const ctx = {
    turn: { content: 'hi' },
    conversationId: `c-${lateText}`,
    message: null,
    sessionId: null,
    cwd: '.',
    onLateReply: async (text: string) => void late.push(text),
  }
  const reply = await makeClaudeResponder()(ctx as never)
  await new Promise(r => setTimeout(r, 10))
  return { reply: reply.kind === 'reply' ? reply.text : reply.kind, late }
}

describe('late wake-ups after background work', () => {
  test('a real late answer is posted', async () => {
    expect(await run('Tests passed.')).toEqual({ reply: 'Answer', late: ['Tests passed.'] })
  })

  test('NO_REPLY is not posted', async () => {
    expect(await run('NO_REPLY')).toEqual({ reply: 'Answer', late: [] })
  })
})

describe('extractAttachments', () => {
  const { extractAttachments } = require('../src/engine/worker')
  const img = `${require('os').tmpdir()}/attach-fixture.png`
  require('fs').writeFileSync(img, 'x')

  test('ATTACH lines become files and leave the text', () => {
    const r = extractAttachments(`Here it is.\nATTACH: ${img}\nDone.`)
    expect(r.files).toEqual([img])
    expect(r.text).toBe('Here it is.\nDone.')
  })

  test('a missing file is reported, not fatal', () => {
    const r = extractAttachments('Look:\nATTACH: /nope/missing.png')
    expect(r.files).toEqual([])
    expect(r.text).toContain('could not attach /nope/missing.png')
  })

  test('attachment-only reply still has text', () => {
    expect(extractAttachments(`ATTACH: ${img}`).text).toBe('attach-fixture.png')
  })
})
