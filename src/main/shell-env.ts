import { execFile } from 'node:child_process'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Apps launched from the Finder or Dock get a bare PATH, so tools installed with
 * Homebrew, npm or the like (git, claude, codex) can't be found. Ask the user's
 * login shell for its PATH once and use that for every child process.
 */

let cached: Promise<string> | undefined

export function loginPath(): Promise<string> {
  cached ??= readLoginPath()
  return cached
}

async function readLoginPath(): Promise<string> {
  const current = process.env['PATH'] ?? ''
  if (process.platform === 'win32') return current
  const shell = process.env['SHELL'] || '/bin/zsh'
  const fromShell = await new Promise<string>((resolve) => {
    // Markers keep anything the shell's rc files print out of the result.
    execFile(shell, ['-ilc', 'printf "__HERMIT_PATH__%s__HERMIT_PATH__" "$PATH"'], { timeout: 5000 }, (err, stdout) => {
      const match = /__HERMIT_PATH__(.*)__HERMIT_PATH__/s.exec(stdout ?? '')
      resolve(err && !match ? '' : (match?.[1] ?? ''))
    })
  })
  const extras = ['/opt/homebrew/bin', '/usr/local/bin', path.join(process.env['HOME'] ?? '', '.local/bin')]
  const parts = [...fromShell.split(':'), ...current.split(':'), ...extras].filter(Boolean)
  return [...new Set(parts)].join(':')
}

export async function childEnv(): Promise<NodeJS.ProcessEnv> {
  return { ...process.env, PATH: await loginPath() }
}

/** The full path of an executable on the login PATH, or null if it isn't installed. */
export async function findExecutable(name: string): Promise<string | null> {
  const dirs = (await loginPath()).split(path.delimiter)
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name]
  for (const dir of dirs) {
    for (const n of names) {
      const candidate = path.join(dir, n)
      try {
        await fs.access(candidate, constants.X_OK)
        return candidate
      } catch {
        // keep looking
      }
    }
  }
  return null
}
