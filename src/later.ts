import { mkdir, readdir, readFile, rename } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { describeError, log } from './log'

export interface LaterJob {
  at: string
  cmd: string[]
  cwd?: string
}

function isJob(value: unknown): value is LaterJob {
  if (!value || typeof value !== 'object') return false
  const job = value as LaterJob
  return typeof job.at === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(job.at) &&
    Number.isFinite(Date.parse(job.at)) &&
    Array.isArray(job.cmd) && job.cmd.length > 0 &&
    job.cmd.every(arg => typeof arg === 'string' && !arg.includes('\0')) &&
    job.cmd[0] !== '' &&
    (job.cwd === undefined || (typeof job.cwd === 'string' && job.cwd !== '' && !job.cwd.includes('\0')))
}

/** Claim before launching so a restart cannot run the same pending file twice. */
export async function tickLater(
  dir: string,
  now: Date,
  run: (name: string, job: LaterJob) => void | Promise<void>,
): Promise<void> {
  await mkdir(dir, { recursive: true })
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15)
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.json')) continue
    const name = file.slice(0, -5)
    const source = join(dir, file)
    try {
      let job: LaterJob
      try {
        const value: unknown = JSON.parse(await readFile(source, 'utf8'))
        if (!/^[a-z0-9-]+$/.test(name) || !isJob(value)) throw new Error('invalid job fields or name')
        job = value
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
        await mkdir(join(dir, 'bad'), { recursive: true })
        await rename(source, join(dir, 'bad', file))
        log.error('invalid later job', { name, error: describeError(err) })
        continue
      }
      if (Date.parse(job.at) > now.getTime()) continue
      await mkdir(join(dir, 'fired'), { recursive: true })
      await rename(source, join(dir, 'fired', `${name}.${stamp}.json`))
      log.info('later job due', { name, lateMinutes: (now.getTime() - Date.parse(job.at)) / 60_000 })
      await run(name, job)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.error('later job failed', { name, error: describeError(err) })
      }
    }
  }
}

/** A separate user service keeps the command alive across daemon restarts. */
export async function runLater(name: string, job: LaterJob): Promise<void> {
  // systemd-run does not expand %n, so the failure unit is named outright.
  const unit = `later-${name}-${Math.floor(Date.now() / 1000)}`
  const args = [
    'systemd-run', '--user', '--collect', `--unit=${unit}`,
    `--property=OnFailure=failure-alert@${unit}.service`,
    ...(job.cwd === undefined ? [] : [`--working-directory=${job.cwd}`]),
    `--setenv=PATH=${homedir()}/.local/bin:${process.env.PATH ?? ''}`, '--', ...job.cmd,
  ]
  try {
    const child = Bun.spawn(args, { stdout: 'inherit', stderr: 'inherit' })
    log.info('later job launched', { name, cmd: job.cmd })
    const exitCode = await child.exited
    if (exitCode !== 0) log.error('later systemd-run failed', { name, exitCode })
  } catch (err) {
    log.error('later launch failed', { name, error: describeError(err) })
  }
}
