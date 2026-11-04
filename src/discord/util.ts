/**
 * Small helpers ported from the official plugin's server.ts. These are the
 * hardened bits — they exist because of specific failure modes, so the
 * comments explaining *why* matter more than the code.
 */

import { realpathSync, statSync, mkdirSync, writeFileSync } from 'fs'
import { join, sep } from 'path'
import type { Attachment } from 'discord.js'
import { INBOX_DIR, MAX_ATTACHMENT_BYTES, MAX_CHUNK_LIMIT, STATE_DIR } from '../config'

/**
 * Discord rejects messages over 2000 characters outright, so long replies are
 * split. `newline` mode aims for equal-sized parts (no 1990 + 110 orphan),
 * prefers cutting before a heading, then at a paragraph, line or word, and
 * closes a code fence cut in half and reopens it in the next part so neither
 * half renders as garbage.
 */
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  // Too small to fit a reopened fence and still make progress.
  if (mode === 'length' || limit < 40) {
    const out: string[] = []
    for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit))
    return out
  }
  // Room for the "\n```" that closes a fence cut in half.
  const budget = Math.max(1, limit - 4)
  const out: string[] = []
  let rest = text
  let fence: string | null = null
  for (;;) {
    const floor = fence ? fence.length + 1 : 0
    if (fence) rest = `${fence}\n${rest}`
    if (rest.length <= limit) break
    const target = Math.ceil(rest.length / Math.ceil(rest.length / budget))
    const cut = boundary(rest, target, floor)
    let piece = rest.slice(0, cut)
    fence = openFence(piece)
    if (fence) piece += '\n```'
    out.push(piece)
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

/**
 * Best cut at or before `max`, but not in the front half (no tiny parts) and
 * past `floor`, the reopened fence, so every part consumes real text.
 */
function boundary(s: string, max: number, floor: number): number {
  const min = Math.max(max / 2, floor)
  const head = lastMatch(s, /\n(?=#{1,3} |\*\*)/g, max)
  if (head > min) return head
  for (const sep of ['\n\n', '\n', ' ']) {
    const i = s.lastIndexOf(sep, max)
    if (i > min) return i
  }
  return max
}

function lastMatch(s: string, re: RegExp, max: number): number {
  let last = -1
  for (const m of s.slice(0, max + 1).matchAll(re)) last = m.index!
  return last
}

/**
 * Hard-wrap prose at `width` so lines stay readable on a wide Discord window
 * (Norio 4 Nov 2026). Code blocks, headings, footers and words longer than the
 * width (URLs) are left alone; list and quote continuations keep their prefix.
 */
export function wrap(text: string, width = 80): string {
  let fenced = false
  return text.split('\n').map(line => {
    if (line.trim().startsWith('```')) fenced = !fenced
    if (fenced || line.trim().startsWith('```') || line.length <= width || /^\s*(#|-#|\|)/.test(line)) return line
    const lead = line.match(/^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])?\s*)/)![1]!
    const pad = lead.startsWith('>') ? lead.replace(/[-*+]|\d+[.)]/, m => ' '.repeat(m.length)) : ' '.repeat(lead.length)
    const out: string[] = []
    let cur = lead
    let empty = true
    for (const word of line.slice(lead.length).split(' ')) {
      if (!empty && cur.length + word.length + 1 > width) { out.push(cur); cur = pad; empty = true }
      cur += (empty ? '' : ' ') + word
      empty = false
    }
    out.push(cur.trimEnd())
    return out.join('\n')
  }).join('\n')
}

/** The opening fence line (e.g. "```ts") if `s` ends inside a code block. */
export function openFence(s: string): string | null {
  let open: string | null = null
  for (const line of s.split('\n')) {
    const t = line.trim()
    if (t.startsWith('```')) open = open ? null : t
  }
  return open
}

export function clampChunkLimit(configured: number | undefined): number {
  return Math.max(1, Math.min(configured ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
}

/**
 * Refuse to upload the channel's own state directory.
 *
 * Attachment paths are model-supplied. Claude can already read and paste file
 * contents, so this is not a general exfiltration boundary — but access.json
 * and .env are the one thing it has no legitimate reason to send, and the
 * token lives there. inbox/ is exempt: those files came from Discord already.
 */
export function assertSendable(f: string): void {
  let real: string
  let stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch {
    // statSync will surface a real error; or STATE_DIR is absent, so there is
    // nothing to leak.
    return
  }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

export function assertAttachable(paths: string[]): void {
  if (paths.length > 10) throw new Error('Discord allows max 10 attachments per message')
  for (const f of paths) {
    assertSendable(f)
    const st = statSync(f)
    if (st.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`,
      )
    }
  }
}

/**
 * Attachment names are uploader-controlled and get interpolated into
 * annotations and newline-joined tool results, where these characters would
 * let an attacker break out of the untrusted frame.
 */
export function safeAttName(att: Attachment): string {
  return (att.name ?? att.id).replace(/[\[\]\r\n;]/g, '_')
}

export async function downloadAttachment(att: Attachment): Promise<string> {
  if (att.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, ` +
        `max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`,
    )
  }
  const res = await fetch(att.url)
  const buf = Buffer.from(await res.arrayBuffer())
  const name = att.name ?? att.id
  const rawExt = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin'
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const path = join(INBOX_DIR, `${Date.now()}-${att.id}.${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, buf)
  return path
}

/**
 * Discord thread names are capped at 100 characters. Collapse whitespace and
 * trim to something that reads as a title in the sidebar.
 */
export function threadName(raw: string, fallback = 'conversation'): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (!flat) return fallback
  if (flat.length <= 90) return flat
  return flat.slice(0, 89).replace(/\s\S*$/, '') + '…'
}
