import { CapacitorHttp } from '@capacitor/core'
import * as git from 'isomorphic-git'
import type { GitHttpRequest, GitHttpResponse } from 'isomorphic-git'
import {
  commitMessage,
  conflictLabel,
  isMetaFile,
  MAX_COMMIT_WAIT,
  mergeMeta,
  normalizeSyncSettings,
  withIgnored
} from '../shared/sync'
import type { ConflictFile, SyncSettings, SyncState, SyncStatus } from '../shared/types'
import { fromBase64, gitFs, nativeFs, toBase64 } from './fs'
import { mergeText } from './merge'
import { errorCode, native } from './native'

/**
 * Keeps the library in sync with a GitHub repository, like the desktop app does, but without a `git` to run:
 * isomorphic-git does the git work in the page, over HTTPS, signing in with an access token from the keychain.
 *
 * The repository's `.git` lives in the app's private storage rather than in the library, so a library in a
 * shared folder (such as iCloud Drive) never has two apps writing one repository.
 *
 * Each sync: save open edits → commit everything → fetch → fast-forward or merge → push. Merging is done
 * here, file by file, with the same diff3-style conflict markers git writes. A merge that conflicts waits,
 * recorded in `hermit-merge.json` beside the repository, until the writer resolves it in the merge editor.
 */

export interface SyncHost {
  /** Ask the page to write any unsaved edits to disk. */
  flush(): Promise<void>
  emitState(state: SyncState): void
  emitChanged(paths: string[]): void
  saveSettings(settings: SyncSettings): Promise<void>
  /** Connecting to a repository that already has writing in it: clear away anything that shouldn't join it. */
  beforeJoining(): Promise<void>
}

/** Who commits are by: the GitHub account the token belongs to. */
export interface Author {
  name: string
  email: string
}

/** A merge waiting on the writer: the two commits being merged and the files left in conflict. */
interface MergeState {
  ours: string
  theirs: string
  conflicts: string[]
}

const TOKEN_KEY = 'github-token'
const FALLBACK_AUTHOR: Author = { name: 'Hermit Crab', email: 'hermit-crab@users.noreply.github.com' }

/** Files merged line by line; anything else is kept as this device has it when both sides change it. */
const isText = (file: string) => /\.(md|markdown|txt|fountain|canvas|json|gitignore)$/i.test(file) || file === '.gitignore'

/** An HTTP client for isomorphic-git that goes through the native side, which isn't bound by CORS. */
const http = {
  async request({ url, method = 'GET', headers = {}, body }: GitHttpRequest): Promise<GitHttpResponse> {
    let data: string | undefined
    if (body) {
      const chunks: Uint8Array[] = []
      for await (const chunk of body) chunks.push(chunk)
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
      let at = 0
      for (const chunk of chunks) {
        all.set(chunk, at)
        at += chunk.length
      }
      data = toBase64(all)
    }
    const response = await CapacitorHttp.request({
      url,
      method,
      headers,
      data,
      dataType: data === undefined ? undefined : 'file',
      responseType: 'arraybuffer'
    })
    const bytes =
      typeof response.data === 'string'
        ? fromBase64(response.data)
        : new TextEncoder().encode(JSON.stringify(response.data ?? ''))
    return {
      url: response.url || url,
      method,
      statusCode: response.status,
      statusMessage: String(response.status),
      headers: response.headers,
      body: [bytes] as unknown as AsyncIterableIterator<Uint8Array>
    }
  }
}

/** GitHub's HTTPS address for a repository, from any of the ways people paste one. */
export function httpsUrl(raw: string): string {
  const url = raw.trim()
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/](.+?)(?:\.git)?\/?$/.exec(url)
  if (ssh) return `https://github.com/${ssh[1]}.git`
  const bare = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)
  if (bare) return `https://github.com/${bare[1]}.git`
  // Plain HTTP only to this machine, such as a test server, so the token is never sent in the clear.
  if (/^https:\/\//.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) return url
  throw new Error('Enter the repository’s HTTPS address, such as https://github.com/you/writing.git.')
}

/** Turn a sync failure into one sentence a writer can act on. */
function friendlyError(err: unknown): string {
  const status = (err as { data?: { statusCode?: number } })?.data?.statusCode
  const message = err instanceof Error ? err.message : String(err)
  if (status === 401 || status === 403 || /401|403|authenticat/i.test(message)) {
    return 'GitHub didn’t accept your access token. Check that it hasn’t expired and can read and write this repository.'
  }
  if (status === 404) return 'Repository not found. Check the address and that your access token can see it.'
  if (/offline|network|host|timed out|connection|internet/i.test(message)) return 'Can’t reach GitHub. Will try again shortly.'
  return message || 'Sync failed.'
}

/** The parent of a slash-separated path, or '' at the top. */
const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')))

export class MobileSync {
  private status: SyncStatus = 'off'
  private message: string | undefined
  private lastSyncedAt: number | undefined
  private lastPullAt = 0
  private conflicts: string[] = []
  private remoteUrl: string | null = null
  private hasToken = false
  private running: Promise<void> | null = null
  private again = false
  private commitTimer: number | undefined
  private firstDirtyAt = 0
  private pullTimer: number | undefined
  /** isomorphic-git's cache of parsed packfiles; without it, every object read loads its pack again. */
  private cache: object = {}

  constructor(
    private dir: string,
    private gitdir: string,
    private settings: SyncSettings,
    private author: Author | null,
    private readonly host: SyncHost,
    private readonly saveAuthor: (author: Author) => Promise<void>
  ) {}

  private get repo() {
    return { fs: gitFs, dir: this.dir, gitdir: this.gitdir, cache: this.cache }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.hasToken = Boolean(await this.token())
    await this.inspect()
    this.schedulePulls()
    if (this.active) void this.sync()
  }

  /** The library moved to another folder, which has a repository of its own (or none yet). */
  async setRoot(dir: string, gitdir: string, settings: SyncSettings): Promise<void> {
    this.dir = dir
    this.gitdir = gitdir
    this.settings = settings
    this.lastSyncedAt = undefined
    await this.inspect()
    this.schedulePulls()
    if (this.active) void this.sync()
  }

  private get active(): boolean {
    return this.settings.enabled && Boolean(this.remoteUrl) && this.hasToken
  }

  private async token(): Promise<string | null> {
    return (await native.getSecret({ key: TOKEN_KEY }).catch(() => ({ value: null }))).value
  }

  private onAuth = async () => ({ username: 'x-access-token', password: (await this.token()) ?? '' })

  private async isRepo(): Promise<boolean> {
    return gitFs.promises.stat(`${this.gitdir}/HEAD`).then(
      () => true,
      () => false
    )
  }

  private async readMerge(): Promise<MergeState | null> {
    try {
      return JSON.parse(await nativeFs.readText(`${this.gitdir}/hermit-merge.json`)) as MergeState
    } catch {
      return null
    }
  }

  private async writeMerge(state: MergeState | null): Promise<void> {
    const file = `${this.gitdir}/hermit-merge.json`
    if (state) await nativeFs.writeText(file, JSON.stringify(state))
    else await native.remove({ path: file })
    this.conflicts = state?.conflicts ?? []
  }

  /** Read the repository's state from disk. */
  private async inspect(): Promise<void> {
    this.remoteUrl = null
    this.conflicts = []
    let status: SyncStatus = 'off'
    if (await this.isRepo()) {
      this.remoteUrl = ((await git.getConfig({ ...this.repo, path: 'remote.origin.url' })) as string | undefined) ?? null
      const merge = await this.readMerge()
      if (merge) {
        this.conflicts = merge.conflicts
        status = 'conflict'
      } else if (this.active) {
        status = 'idle'
      }
    }
    this.setStatus(status, this.hasToken || !this.remoteUrl ? undefined : 'Add an access token to sync.')
  }

  getState(): SyncState {
    return {
      settings: this.settings,
      gitAvailable: true,
      credentials: 'token',
      hasToken: this.hasToken,
      agents: { claude: false, codex: false },
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
    this.afterChange(wasActive)
    return this.getState()
  }

  private afterChange(wasActive: boolean): void {
    if (this.status === 'conflict' || this.status === 'resolving') {
      this.host.emitState(this.getState())
    } else if (!this.active) {
      window.clearTimeout(this.commitTimer)
      this.setStatus('off', this.status === 'error' ? undefined : this.message)
    } else if (!wasActive) {
      void this.sync()
    } else {
      this.host.emitState(this.getState())
    }
  }

  /** Save the token in the keychain, and note who it belongs to so commits are theirs. */
  async setToken(token: string | null): Promise<SyncState> {
    const wasActive = this.active
    const value = token?.trim()
    if (!value) {
      await native.deleteSecret({ key: TOKEN_KEY })
      this.hasToken = false
    } else {
      const author = await this.lookUpAuthor(value)
      await native.setSecret({ key: TOKEN_KEY, value })
      this.hasToken = true
      this.author = author
      await this.saveAuthor(author)
    }
    this.afterChange(wasActive)
    return this.getState()
  }

  /** The token's owner, from GitHub, which also checks the token works. */
  private async lookUpAuthor(token: string): Promise<Author> {
    let response
    try {
      response = await CapacitorHttp.get({
        url: 'https://api.github.com/user',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
      })
    } catch (err) {
      throw new Error(friendlyError(err))
    }
    if (response.status === 401) throw new Error('GitHub didn’t accept that token. Check it was copied in full.')
    if (response.status !== 200) return FALLBACK_AUTHOR
    const user = response.data as { login?: string; name?: string | null; id?: number }
    if (!user.login) return FALLBACK_AUTHOR
    return { name: user.name || user.login, email: `${user.id}+${user.login}@users.noreply.github.com` }
  }

  // ── Triggers ──────────────────────────────────────────────────────────────

  /** Something in the library changed: commit once the writer pauses. */
  noteChange(): void {
    if (!this.active) return
    const now = Date.now()
    this.firstDirtyAt ||= now
    const delay = this.settings.commitDelay * 1000
    const deadline = this.firstDirtyAt + Math.max(delay, MAX_COMMIT_WAIT)
    window.clearTimeout(this.commitTimer)
    this.commitTimer = window.setTimeout(() => void this.sync(), Math.max(0, Math.min(delay, deadline - now)))
  }

  /** The app came back to the front: check GitHub if we haven't in a while. */
  pullSoon(): void {
    if (this.active && Date.now() - this.lastPullAt > 60_000) void this.sync()
  }

  private schedulePulls(): void {
    window.clearInterval(this.pullTimer)
    this.pullTimer = window.setInterval(() => {
      if (this.active) void this.sync()
    }, this.settings.pullInterval * 60_000)
  }

  // ── Repository ────────────────────────────────────────────────────────────

  private async resolve(ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ ...this.repo, ref })
    } catch {
      return null
    }
  }

  private async localBranch(): Promise<string> {
    return (await git.currentBranch({ ...this.repo })) ?? this.settings.branch
  }

  private async ensureRepo(): Promise<void> {
    if (!(await this.isRepo())) {
      await native.mkdir({ path: this.gitdir, recursive: true })
      await git.init({ ...this.repo, defaultBranch: this.settings.branch })
    }
    const ignoreFile = `${this.dir}/.gitignore`
    const ignore = withIgnored(await nativeFs.readText(ignoreFile).catch(() => ''))
    if (ignore !== null) await nativeFs.writeText(ignoreFile, ignore)
  }

  async connect(remoteUrl: string): Promise<SyncState> {
    if (!remoteUrl.trim()) throw new Error('Enter the repository’s address.')
    if (!this.hasToken) throw new Error('Add an access token first.')
    const url = httpsUrl(remoteUrl)

    // Check access now so a bad address or token is reported right away.
    let info
    try {
      info = await git.getRemoteInfo({ http, url, onAuth: this.onAuth })
    } catch (err) {
      throw new Error(friendlyError(err))
    }
    const defaultBranch = typeof info.HEAD === 'string' ? info.HEAD.replace(/^refs\/heads\//, '') : undefined
    if (Object.keys(info.refs?.heads ?? {}).length && !(await this.resolve('HEAD'))) await this.host.beforeJoining()

    await this.ensureRepo()
    await git.setConfig({ ...this.repo, path: 'remote.origin.url', value: url })
    await git.setConfig({ ...this.repo, path: 'remote.origin.fetch', value: '+refs/heads/*:refs/remotes/origin/*' })
    this.remoteUrl = url
    this.settings = normalizeSyncSettings({ ...this.settings, enabled: true, branch: defaultBranch ?? this.settings.branch })
    await this.host.saveSettings(this.settings)
    this.schedulePulls()
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
    const merge = await this.readMerge()
    if (merge) {
      this.conflicts = merge.conflicts
      if (this.status !== 'resolving') this.setStatus('conflict', this.message)
      return
    }

    this.setStatus('syncing')
    // A fetch brings new packs; start each sync with nothing cached.
    this.cache = {}
    try {
      const branch = this.settings.branch
      // Fetch before saving and committing, so the gap between the writer's last
      // saved keystroke and the merge stays as short as possible.
      let fetchError: unknown = null
      let remoteMissing = false
      try {
        await git.fetch({ ...this.repo, http, remote: 'origin', ref: branch, singleBranch: true, tags: false, onAuth: this.onAuth })
      } catch (err) {
        // An empty repository, or one without this branch yet: there's nothing to pull, only to push.
        if ((err as { code?: string }).code === 'NotFoundError' || /could not find|empty/i.test(String(err))) remoteMissing = true
        else fetchError = err
      }

      await this.host.flush()
      window.clearTimeout(this.commitTimer)
      this.firstDirtyAt = 0
      await this.ensureRepo()
      await this.commitAll()

      // Offline is fine: the commit above is safe, and the next sync will push it.
      if (fetchError) throw fetchError
      this.lastPullAt = Date.now()
      const remote = remoteMissing ? null : await this.resolve(`refs/remotes/origin/${branch}`)
      let head = await this.resolve('HEAD')

      if (remote && remote !== head) {
        if (!head || (await git.isDescendent({ ...this.repo, oid: remote, ancestor: head, depth: -1 }))) {
          await this.fastForward(head, remote)
        } else if (!(await git.isDescendent({ ...this.repo, oid: head, ancestor: remote, depth: -1 }))) {
          const settled = await this.merge(head, remote)
          if (!settled) return
        }
        head = await this.resolve('HEAD')
      }

      if (head && head !== remote) {
        try {
          const result = await git.push({
            ...this.repo,
            http,
            remote: 'origin',
            ref: await this.localBranch(),
            remoteRef: branch,
            onAuth: this.onAuth
          })
          if (!result.ok) throw new Error(result.error ?? 'GitHub didn’t take the changes.')
        } catch (err) {
          // Someone pushed between our fetch and push: go round once more.
          if ((err as { code?: string }).code === 'PushRejectedError') this.again = true
          else throw err
        }
      }

      if (!this.again) this.lastSyncedAt = Date.now()
      this.setStatus('idle')
    } catch (err) {
      console.error('Sync failed', err)
      this.setStatus('error', friendlyError(err))
    }
  }

  /** Stage every change in the library and commit it, with a message describing what changed. */
  private async commitAll(): Promise<void> {
    const matrix = await git.statusMatrix({ ...this.repo })
    const changed: string[] = []
    for (const [file, head, workdir, stage] of matrix) {
      const differs = head ? workdir !== 1 : workdir !== 0
      if (!differs && stage === 1) continue
      if (workdir === 0) await git.remove({ ...this.repo, filepath: file })
      else await git.add({ ...this.repo, filepath: file })
      if (differs) changed.push(file)
    }
    if (!changed.length) return
    const first = (await this.resolve('HEAD')) === null
    const read = (file: string) => nativeFs.readText(`${this.dir}/${file}`).catch(() => null)
    const message = first ? 'Start syncing with Hermit Crab' : await commitMessage(changed, read)
    await git.commit({ ...this.repo, message, author: this.author ?? FALLBACK_AUTHOR })
  }

  /** Every file in a commit, by path, with its blob's id. */
  private async filesOf(commit: string | null): Promise<Map<string, string>> {
    const files = new Map<string, string>()
    if (!commit) return files
    await git.walk({
      ...this.repo,
      trees: [git.TREE({ ref: commit })],
      map: async (file, [entry]) => {
        if (file !== '.' && entry && (await entry.type()) === 'blob') files.set(file, await entry.oid())
        return true
      }
    })
    return files
  }

  private async blobText(oid: string | undefined): Promise<string | null> {
    if (!oid) return null
    const { blob } = await git.readBlob({ ...this.repo, oid })
    return new TextDecoder().decode(blob)
  }

  /** Put a file in the library as it is in a blob, or with null, remove it and any folders it leaves empty. */
  private async writeFile(file: string, oid: string | undefined): Promise<void> {
    const path = `${this.dir}/${file}`
    if (oid) {
      const { blob } = await git.readBlob({ ...this.repo, oid })
      await native.mkdir({ path: parentOf(path), recursive: true })
      await native.writeFile({ path, data: toBase64(blob) })
      return
    }
    await native.remove({ path })
    for (let folder = parentOf(file); folder; folder = parentOf(folder)) {
      try {
        await native.rmdir({ path: `${this.dir}/${folder}` })
      } catch (err) {
        if (errorCode(err) !== 'ENOENT') break
      }
    }
  }

  private async stage(file: string, present: boolean): Promise<void> {
    if (present) await git.add({ ...this.repo, filepath: file })
    else await git.remove({ ...this.repo, filepath: file })
  }

  /** Move the branch on to a commit made from this one, updating the files that changed. */
  private async fastForward(head: string | null, remote: string): Promise<void> {
    const [from, to] = await Promise.all([this.filesOf(head), this.filesOf(remote)])
    const changed = [...new Set([...from.keys(), ...to.keys()])].filter((f) => from.get(f) !== to.get(f))
    for (const file of changed) {
      await this.writeFile(file, to.get(file))
      await this.stage(file, to.has(file))
    }
    await git.writeRef({ ...this.repo, ref: `refs/heads/${await this.localBranch()}`, value: remote, force: true })
    this.host.emitChanged(changed)
  }

  /**
   * Merge GitHub's commits with ours, file by file. Resolves with whether the merge is done; if not,
   * it waits on the writer to resolve its conflicts.
   */
  private async merge(head: string, remote: string): Promise<boolean> {
    const [base] = await git.findMergeBase({ ...this.repo, oids: [head, remote] })
    const [original, ours, theirs] = await Promise.all([
      this.filesOf((base as string | undefined) ?? null),
      this.filesOf(head),
      this.filesOf(remote)
    ])
    const changed: string[] = []
    const conflicts: string[] = []
    for (const file of new Set([...original.keys(), ...ours.keys(), ...theirs.keys()])) {
      const [b, o, t] = [original.get(file), ours.get(file), theirs.get(file)]
      if (o === t || b === t) continue
      if (b === o) {
        await this.writeFile(file, t)
        await this.stage(file, Boolean(t))
        changed.push(file)
        continue
      }
      // Both sides changed it.
      const path = `${this.dir}/${file}`
      if (o && t && isMetaFile(file)) {
        await native.writeFile({ path, data: mergeMeta(await this.blobText(o), await this.blobText(t)), encoding: 'utf8' })
        await this.stage(file, true)
      } else if (o && t && isText(file)) {
        const merged = mergeText((await this.blobText(b)) ?? '', (await this.blobText(o))!, (await this.blobText(t))!)
        await native.writeFile({ path, data: merged.text, encoding: 'utf8' })
        if (merged.conflicts) conflicts.push(file)
        else await this.stage(file, true)
      } else if (o && t) {
        // Images and the like can't be merged; keep this device's.
        continue
      } else {
        // Changed on one side, deleted on the other: keep the changed version on disk until the writer decides.
        if (!o) await this.writeFile(file, t)
        conflicts.push(file)
      }
      changed.push(file)
    }

    if (!conflicts.length) {
      await git.commit({ ...this.repo, message: 'Merge changes from GitHub', author: this.author ?? FALLBACK_AUTHOR, parent: [head, remote] })
      this.host.emitChanged(changed)
      return true
    }
    await this.writeMerge({ ours: head, theirs: remote, conflicts })
    this.host.emitChanged(changed)
    const n = conflicts.length
    this.setStatus('conflict', `${n} ${n === 1 ? 'file' : 'files'} changed both here and on GitHub.`)
    return false
  }

  // ── Conflicts ─────────────────────────────────────────────────────────────

  async listConflicts(): Promise<ConflictFile[]> {
    const merge = await this.readMerge()
    if (!merge) return []
    const [ours, theirs] = await Promise.all([this.filesOf(merge.ours), this.filesOf(merge.theirs)])
    return Promise.all(
      merge.conflicts.map(async (file) => {
        const [a, b, content] = await Promise.all([
          this.blobText(ours.get(file)),
          this.blobText(theirs.get(file)),
          nativeFs.readText(`${this.dir}/${file}`).catch(() => '')
        ])
        return { path: file, label: conflictLabel(file, a, b), ours: a, theirs: b, content }
      })
    )
  }

  async resolveConflict(file: string, content: string | null): Promise<SyncState> {
    const merge = await this.readMerge()
    if (!merge?.conflicts.includes(file)) throw new Error(`${file} isn’t in conflict.`)
    if (content === null) await this.writeFile(file, undefined)
    else await native.writeFile({ path: `${this.dir}/${file}`, data: content, encoding: 'utf8' })
    await this.stage(file, content !== null)
    await this.writeMerge({ ...merge, conflicts: merge.conflicts.filter((f) => f !== file) })
    this.host.emitChanged([file])
    this.setStatus('conflict', this.conflicts.length ? this.message : 'Everything is resolved. Finish the merge to sync.')
    return this.getState()
  }

  async finishMerge(): Promise<SyncState> {
    const merge = await this.readMerge()
    if (merge?.conflicts.length) throw new Error('Some files still have conflicts.')
    if (merge) {
      await git.commit({
        ...this.repo,
        message: 'Merge changes from GitHub',
        author: this.author ?? FALLBACK_AUTHOR,
        parent: [merge.ours, merge.theirs]
      })
      await this.writeMerge(null)
    }
    this.setStatus(this.active ? 'idle' : 'off')
    await this.sync()
    return this.getState()
  }
}
