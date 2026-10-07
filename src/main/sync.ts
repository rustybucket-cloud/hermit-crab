import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commitMessage, conflictLabel, isMetaFile, MAX_COMMIT_WAIT, mergeMeta, normalizeSyncSettings, withIgnored } from '../shared/sync'
import type { ConflictFile, SyncAgent, SyncSettings, SyncState, SyncStatus } from '../shared/types'
import { childEnv, findExecutable } from './shell-env'

/**
 * Keeps the library folder in sync with a GitHub repository using the user's own
 * `git`, so whatever credentials already work in their terminal (SSH keys, the
 * GitHub CLI, the macOS keychain) work here too.
 *
 * Each sync: save open edits → commit everything → fetch → merge → push.
 * A merge that conflicts is left in progress on disk until the user resolves it
 * in the merge editor (optionally with help from Claude Code or Codex).
 */

export const AGENT_NAMES: Record<SyncAgent, string> = { claude: 'Claude Code', codex: 'Codex' }

const AGENT_TIMEOUT = 10 * 60_000

export interface SyncHost {
  /** Ask the renderer to write any unsaved edits to disk. */
  flush(): Promise<void>
  emitState(state: SyncState): void
  emitChanged(paths: string[]): void
  emitAgentOutput(chunk: string): void
  saveSettings(settings: SyncSettings): Promise<void>
}

interface GitResult {
  stdout: string
  stderr: string
  code: number
}

/** Turn git's stderr into one sentence a writer can act on. */
function friendlyGitError(raw: string): string {
  const text = raw.trim()
  if (/could not resolve host|network is unreachable|timed out|connection refused/i.test(text)) {
    return 'Can’t reach GitHub. Will try again shortly.'
  }
  if (/repository not found|does not appear to be a git repository/i.test(text)) {
    return 'Repository not found. Check the URL and that your GitHub account can access it.'
  }
  if (/authentication failed|permission denied|could not read username|terminal prompts disabled|403/i.test(text)) {
    return 'GitHub didn’t accept your credentials. Make sure `git push` works for this repository in Terminal (for example, run `gh auth setup-git`).'
  }
  const lines = text.split('\n').map((l) => l.replace(/^(fatal|error|hint):\s*/, '').trim()).filter(Boolean)
  return lines[0] ?? 'Git failed.'
}

function agentPrompt(files: string[]): string {
  return [
    'You are resolving git merge conflicts in a folder of Markdown writing (a Hermit Crab library).',
    'These files contain conflict markers (<<<<<<<, |||||||, =======, >>>>>>>):',
    ...files.map((f) => `- ${f}`),
    '',
    'In each block, the text between <<<<<<< and ||||||| was written on this computer; the text between ||||||| and ======= is the original both sides started from; the text between ======= and >>>>>>> came from GitHub.',
    'Compare each side with the original to see exactly what each one changed.',
    'Edit each file so that no conflict markers remain, combining both versions so no writing is lost:',
    '- keep text that only one side added or changed;',
    '- where both sides rewrote the same passage, merge the edits if they are compatible, otherwise keep the version that reads as the more complete revision;',
    '- preserve the author’s wording, voice and Markdown formatting, and do not change anything outside the conflict blocks.',
    'Only edit the files listed above. Do not run git commands, and do not create, delete or rename files.'
  ].join('\n')
}

export class GitSync {
  private status: SyncStatus = 'off'
  private message: string | undefined
  private lastSyncedAt: number | undefined
  private lastPullAt = 0
  private conflicts: string[] = []
  private remoteUrl: string | null = null
  private gitPath: string | null = null
  private agents: Record<SyncAgent, boolean> = { claude: false, codex: false }
  private running: Promise<void> | null = null
  private again = false
  private commitTimer: NodeJS.Timeout | undefined
  private firstDirtyAt = 0
  private pullTimer: NodeJS.Timeout | undefined
  private agent: ChildProcess | null = null

  constructor(
    private root: string,
    private settings: SyncSettings,
    private readonly host: SyncHost
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const [git, claude, codex] = await Promise.all([
      findExecutable('git'),
      findExecutable('claude'),
      findExecutable('codex')
    ])
    this.gitPath = git
    this.agents = { claude: Boolean(claude), codex: Boolean(codex) }
    await this.inspect()
    this.schedulePulls()
    if (this.active) void this.sync()
  }

  /** The library moved to another folder; it may or may not be a repository already. */
  async setRoot(root: string): Promise<void> {
    this.root = root
    this.lastSyncedAt = undefined
    await this.inspect()
    if (this.active) void this.sync()
  }

  stop(): void {
    clearTimeout(this.commitTimer)
    clearInterval(this.pullTimer)
    this.agent?.kill()
  }

  private get active(): boolean {
    return this.settings.enabled && Boolean(this.remoteUrl) && Boolean(this.gitPath)
  }

  /** Read the repository's current state from disk. */
  private async inspect(): Promise<void> {
    this.remoteUrl = null
    this.conflicts = []
    let status: SyncStatus = 'off'
    let message: string | undefined
    if (!this.gitPath) {
      message = 'Git isn’t installed. Install the Xcode Command Line Tools (run `xcode-select --install`) or get git from git-scm.com.'
    } else if (await this.isRepo()) {
      const remote = await this.git(['remote', 'get-url', 'origin'], true)
      this.remoteUrl = remote.code === 0 ? remote.stdout.trim() || null : null
      if (await this.isMerging()) {
        await this.refreshConflicts()
        status = 'conflict'
      } else if (this.active) {
        status = 'idle'
      }
    }
    this.setStatus(status, message)
  }

  getState(): SyncState {
    return {
      settings: this.settings,
      gitAvailable: Boolean(this.gitPath),
      credentials: 'system',
      agents: this.agents,
      remoteUrl: this.remoteUrl,
      status: this.status,
      message: this.message,
      lastSyncedAt: this.lastSyncedAt,
      conflicts: this.conflicts
    }
  }

  private setStatus(status: SyncStatus, message?: string): void {
    this.status = status
    this.message = message
    this.host.emitState(this.getState())
  }

  async updateSettings(patch: Partial<SyncSettings>): Promise<SyncState> {
    const wasActive = this.active
    this.settings = normalizeSyncSettings({ ...this.settings, ...patch })
    await this.host.saveSettings(this.settings)
    this.schedulePulls()
    if (this.status === 'conflict' || this.status === 'resolving') {
      this.host.emitState(this.getState())
    } else if (!this.active) {
      clearTimeout(this.commitTimer)
      this.setStatus('off', this.status === 'error' ? undefined : this.message)
    } else if (!wasActive) {
      void this.sync()
    } else {
      this.host.emitState(this.getState())
    }
    return this.getState()
  }

  // ── Triggers ──────────────────────────────────────────────────────────────

  /** Something in the library changed: commit once the writer pauses. */
  noteChange(): void {
    if (!this.active) return
    const now = Date.now()
    this.firstDirtyAt ||= now
    const delay = this.settings.commitDelay * 1000
    const deadline = this.firstDirtyAt + Math.max(delay, MAX_COMMIT_WAIT)
    clearTimeout(this.commitTimer)
    this.commitTimer = setTimeout(() => void this.sync(), Math.max(0, Math.min(delay, deadline - now)))
  }

  /** The window regained focus: check GitHub if we haven't in a while. */
  pullSoon(): void {
    if (this.active && Date.now() - this.lastPullAt > 60_000) void this.sync()
  }

  private schedulePulls(): void {
    clearInterval(this.pullTimer)
    this.pullTimer = setInterval(() => {
      if (this.active) void this.sync()
    }, this.settings.pullInterval * 60_000)
  }

  // ── Git ───────────────────────────────────────────────────────────────────

  private async git(args: string[], allowFail = false): Promise<GitResult> {
    const gitPath = this.gitPath
    if (!gitPath) throw new Error('Git isn’t installed.')
    const env = { ...(await childEnv()), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    return new Promise((resolve, reject) => {
      execFile(
        gitPath,
        ['-c', 'core.quotepath=false', ...args],
        { cwd: this.root, env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
          if (code && !allowFail) reject(new Error(friendlyGitError(stderr || err?.message || '')))
          else resolve({ stdout, stderr, code })
        }
      )
    })
  }

  private async names(args: string[]): Promise<string[]> {
    const { stdout } = await this.git([...args, '-z'])
    return stdout.split('\0').filter(Boolean)
  }

  private async revParse(ref: string): Promise<string | null> {
    const result = await this.git(['rev-parse', '--verify', '--quiet', ref], true)
    return result.code === 0 ? result.stdout.trim() : null
  }

  /** The library itself must be the repository, not a folder inside someone else's. */
  private async isRepo(): Promise<boolean> {
    try {
      await fs.stat(path.join(this.root, '.git'))
      return true
    } catch {
      return false
    }
  }

  private async isMerging(): Promise<boolean> {
    return (await this.revParse('MERGE_HEAD')) !== null
  }

  private async refreshConflicts(): Promise<void> {
    this.conflicts = await this.names(['diff', '--name-only', '--diff-filter=U'])
  }

  private async show(spec: string): Promise<string | null> {
    const result = await this.git(['show', spec], true)
    return result.code === 0 ? result.stdout : null
  }

  /** Resolve a path from git against the library, refusing anything that escapes it. */
  private abs(relative: string): string {
    const full = path.resolve(this.root, relative)
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error(`Invalid path: ${relative}`)
    return full
  }

  private async ensureRepo(): Promise<void> {
    if (!(await this.isRepo())) await this.git(['init', '--quiet', '-b', this.settings.branch])

    const ignoreFile = path.join(this.root, '.gitignore')
    const ignore = withIgnored(await fs.readFile(ignoreFile, 'utf8').catch(() => ''))
    if (ignore !== null) await fs.writeFile(ignoreFile, ignore)

    // Commits need an author; fall back to something sensible if git has never been set up.
    if (!(await this.git(['config', 'user.email'], true)).stdout.trim()) {
      await this.git(['config', 'user.email', 'hermit-crab@users.noreply.github.com'])
    }
    if (!(await this.git(['config', 'user.name'], true)).stdout.trim()) {
      await this.git(['config', 'user.name', os.userInfo().username || 'Hermit Crab'])
    }
  }

  async connect(remoteUrl: string): Promise<SyncState> {
    const url = remoteUrl.trim()
    if (!url) throw new Error('Enter the repository’s URL.')
    if (!this.gitPath) throw new Error('Git isn’t installed.')
    await this.ensureRepo()
    const hasOrigin = (await this.git(['remote', 'get-url', 'origin'], true)).code === 0
    await this.git(hasOrigin ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url])

    // Check access now so a bad URL or missing credentials is reported right away.
    const probe = await this.git(['ls-remote', '--symref', 'origin', 'HEAD'], true)
    if (probe.code !== 0) throw new Error(friendlyGitError(probe.stderr))
    const defaultBranch = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(probe.stdout)?.[1]

    this.remoteUrl = url
    this.settings = normalizeSyncSettings({ ...this.settings, enabled: true, branch: defaultBranch ?? this.settings.branch })
    await this.host.saveSettings(this.settings)
    await this.sync()
    return this.getState()
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  /** Run a sync, or queue one more if a sync is already running. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        await this.cycle()
      } while (this.again)
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async cycle(): Promise<void> {
    if (!this.active) return
    if (await this.isMerging()) {
      await this.refreshConflicts()
      if (this.status !== 'resolving') this.setStatus('conflict')
      return
    }

    this.setStatus('syncing')
    try {
      // Fetch before saving and committing, so the gap between the writer's last
      // saved keystroke and the merge stays as short as possible.
      const branch = this.settings.branch
      const fetch = await this.git(['fetch', '--quiet', '--prune', 'origin'], true)

      await this.host.flush()
      clearTimeout(this.commitTimer)
      this.firstDirtyAt = 0
      await this.ensureRepo()
      await this.commitAll()

      // Offline is fine: the commit above is safe, and the next sync will push it.
      if (fetch.code !== 0) throw new Error(friendlyGitError(fetch.stderr))
      this.lastPullAt = Date.now()
      const remote = await this.revParse(`refs/remotes/origin/${branch}`)
      const before = await this.revParse('HEAD')

      if (remote && remote !== before) {
        const merge = await this.git(
          // diff3 markers include the original text, which helps both the writer and the agent see who changed what.
          [
            '-c',
            'merge.conflictStyle=diff3',
            'merge',
            '--no-edit',
            '--allow-unrelated-histories',
            '-m',
            'Merge changes from GitHub',
            `origin/${branch}`
          ],
          true
        )
        if (merge.code !== 0) {
          if (!(await this.isMerging())) throw new Error(friendlyGitError(merge.stderr || merge.stdout))
          await this.autoResolveMeta()
          await this.refreshConflicts()
          this.host.emitChanged(await this.names(before ? ['diff', '--name-only', 'HEAD'] : ['ls-files']))
          if (this.conflicts.length) {
            const n = this.conflicts.length
            this.setStatus('conflict', `${n} ${n === 1 ? 'file' : 'files'} changed both here and on GitHub.`)
            if (this.settings.autoResolve && this.agents[this.settings.agent]) void this.resolveWithAgent().catch(() => {})
            return
          }
          await this.git(['commit', '--quiet', '--no-edit'])
        } else {
          const after = await this.revParse('HEAD')
          if (after && after !== before) {
            this.host.emitChanged(await this.names(before ? ['diff', '--name-only', before, after] : ['ls-files']))
          }
        }
      }

      const head = await this.revParse('HEAD')
      const ahead = head && (!remote || (await this.git(['rev-list', '--count', `${remote}..HEAD`])).stdout.trim() !== '0')
      if (ahead) {
        const push = await this.git(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], true)
        if (push.code !== 0) {
          // Someone pushed between our fetch and push: go round once more.
          if (/rejected|fetch first|non-fast-forward/i.test(push.stderr)) this.again = true
          else throw new Error(friendlyGitError(push.stderr))
        }
      }

      if (!this.again) this.lastSyncedAt = Date.now()
      this.setStatus('idle')
    } catch (err) {
      this.setStatus('error', err instanceof Error ? err.message : String(err))
    }
  }

  /** Commit everything in the library, with a message describing what changed. */
  private async commitAll(): Promise<void> {
    await this.git(['add', '-A'])
    const files = await this.names(['diff', '--cached', '--name-only'])
    if (!files.length) return
    const first = (await this.revParse('HEAD')) === null
    const read = (file: string) => fs.readFile(this.abs(file), 'utf8').catch(() => null)
    const message = first ? 'Start syncing with Hermit Crab' : await commitMessage(files, read)
    await this.git(['commit', '--quiet', '--no-verify', '-m', message])
  }

  /** Project meta files merge mechanically; see mergeMeta. */
  private async autoResolveMeta(): Promise<void> {
    const conflicted = await this.names(['diff', '--name-only', '--diff-filter=U'])
    for (const file of conflicted.filter(isMetaFile)) {
      const [ours, theirs] = await Promise.all([this.show(`:2:${file}`), this.show(`:3:${file}`)])
      await fs.writeFile(this.abs(file), mergeMeta(ours, theirs))
      await this.git(['add', '--', file])
    }
  }

  // ── Conflicts ─────────────────────────────────────────────────────────────

  async listConflicts(): Promise<ConflictFile[]> {
    if (!(await this.isMerging())) return []
    await this.refreshConflicts()
    return Promise.all(
      this.conflicts.map(async (file) => {
        const [ours, theirs, content] = await Promise.all([
          this.show(`:2:${file}`),
          this.show(`:3:${file}`),
          fs.readFile(this.abs(file), 'utf8').catch(() => '')
        ])
        return { path: file, label: conflictLabel(file, ours, theirs), ours, theirs, content }
      })
    )
  }

  async resolveConflict(file: string, content: string | null): Promise<SyncState> {
    if (!this.conflicts.includes(file)) throw new Error(`${file} isn’t in conflict.`)
    if (content === null) {
      await this.git(['rm', '--quiet', '-f', '--', file])
    } else {
      await fs.writeFile(this.abs(file), content, 'utf8')
      await this.git(['add', '--', file])
    }
    await this.refreshConflicts()
    this.host.emitChanged([file])
    this.setStatus('conflict', this.conflicts.length ? this.message : 'Everything is resolved. Finish the merge to sync.')
    return this.getState()
  }

  async finishMerge(): Promise<SyncState> {
    await this.refreshConflicts()
    if (this.conflicts.length) throw new Error('Some files still have conflicts.')
    if (await this.isMerging()) await this.git(['commit', '--quiet', '--no-edit', '--no-verify'])
    this.setStatus(this.active ? 'idle' : 'off')
    await this.sync()
    return this.getState()
  }

  // ── Conflict helpers ──────────────────────────────────────────────────────

  async resolveWithAgent(): Promise<{ ok: boolean; output: string }> {
    if (this.agent) throw new Error('A conflict helper is already running.')
    await this.refreshConflicts()
    const files = this.conflicts
    if (!files.length) return { ok: true, output: '' }

    const which = this.settings.agent
    const name = AGENT_NAMES[which]
    const exe = await findExecutable(which)
    if (!exe) throw new Error(`${name} isn’t installed, or isn’t on your PATH.`)

    // Prompts go in on stdin, so nothing in them is mistaken for a flag.
    const args =
      which === 'claude'
        ? ['-p', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write,Glob,Grep']
        : ['exec', '--sandbox', 'workspace-write', '-']

    this.setStatus('resolving', `${name} is resolving ${files.length === 1 ? 'the conflict' : 'the conflicts'}…`)
    const child = spawn(exe, args, { cwd: this.root, env: await childEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    this.agent = child
    let output = ''
    const collect = (chunk: Buffer) => {
      const text = chunk.toString()
      output += text
      this.host.emitAgentOutput(text)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.stdin.on('error', () => {}) // the process may exit before reading its prompt
    child.stdin.end(agentPrompt(files))

    const timer = setTimeout(() => child.kill(), AGENT_TIMEOUT)
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', (err) => {
        collect(Buffer.from(`\n${err.message}\n`))
        resolve(-1)
      })
      child.on('close', resolve)
    })
    clearTimeout(timer)
    this.agent = null

    const ok = code === 0
    this.host.emitChanged(files)
    this.setStatus(
      'conflict',
      ok ? `${name} has finished. Review its changes, then mark each file resolved.` : `${name} stopped before finishing.`
    )
    return { ok, output }
  }

  cancelAgent(): void {
    this.agent?.kill()
  }
}
