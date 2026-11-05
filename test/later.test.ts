import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { tickLater, type LaterJob } from '../src/later'

let dir: string
const now = new Date('2026-11-08T08:00:00Z')
const due: LaterJob = { at: '2026-11-08T09:59:00+02:00', cmd: ['echo', 'hello world'] }

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'later-test-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

test('claims a due job before running it, and a second tick does not run it again', async () => {
  await writeFile(join(dir, 'hello.json'), JSON.stringify(due))
  const calls: string[] = []
  const run = async (name: string, job: LaterJob) => {
    expect(await readdir(dir)).not.toContain('hello.json')
    expect(JSON.parse(await readFile(join(dir, 'fired', 'hello.20261108T080000.json'), 'utf8'))).toEqual(due)
    expect(job).toEqual(due)
    calls.push(name)
    return true
  }
  await tickLater(dir, now, run)
  await tickLater(dir, now, run)
  expect(calls).toEqual(['hello'])
})

test('leaves a future job untouched', async () => {
  const content = JSON.stringify({ ...due, at: '2026-11-08T08:01:00Z' })
  await writeFile(join(dir, 'future.json'), content)
  let ran = false
  await tickLater(dir, now, () => { ran = true; return true })
  expect(ran).toBe(false)
  expect(await readFile(join(dir, 'future.json'), 'utf8')).toBe(content)
})

test('quarantines bad JSON and missing or invalid fields without throwing', async () => {
  const invalid = ['{', '{}', '{"at":"yesterday","cmd":["echo"]}', JSON.stringify({ ...due, cmd: [] })]
  for (const [i, content] of invalid.entries()) await writeFile(join(dir, `bad-${i}.json`), content)
  let ran = false
  await tickLater(dir, now, () => { ran = true; return true })
  expect(ran).toBe(false)
  expect((await readdir(join(dir, 'bad'))).sort()).toEqual(invalid.map((_, i) => `bad-${i}.json`))
  expect(await readdir(dir)).toEqual(['bad'])
})

test('overlapping ticks claim a job once', async () => {
  await writeFile(join(dir, 'hello.json'), JSON.stringify(due))
  let calls = 0
  await Promise.all([
    tickLater(dir, now, () => { calls++; return true }),
    tickLater(dir, now, () => { calls++; return true }),
  ])
  expect(calls).toBe(1)
})

test('a thrown launch stays claimed and does not block other due jobs', async () => {
  for (const name of ['first', 'second']) await writeFile(join(dir, `${name}.json`), JSON.stringify(due))
  let calls = 0
  const run = (): boolean => { calls++; throw new Error('launch failed') }
  await tickLater(dir, now, run)
  await tickLater(dir, now, run)
  expect(calls).toBe(2)
  expect(await readdir(join(dir, 'fired'))).toHaveLength(2)
})

test('a launch that reports failure goes back to pending and retries next tick', async () => {
  await writeFile(join(dir, 'hello.json'), JSON.stringify(due))
  let calls = 0
  await tickLater(dir, now, () => { calls++; return false })
  expect(await readdir(dir)).toContain('hello.json')
  await tickLater(dir, now, () => { calls++; return true })
  expect(calls).toBe(2)
  expect(await readdir(dir)).not.toContain('hello.json')
})
