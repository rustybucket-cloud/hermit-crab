import type { LibraryFs } from '../shared/library'
import { errorCode, native, type NativeEntry } from './native'

export function toBase64(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** The library's file operations, done natively. There's no trash in an app's folders, so trashing deletes. */
export const nativeFs: LibraryFs = {
  readText: async (path) => (await native.readFile({ path, encoding: 'utf8' })).data,
  writeText: (path, data) => native.writeFile({ path, data, encoding: 'utf8' }),
  writeBytes: (path, data) => native.writeFile({ path, data: toBase64(data) }),
  async readdir(path) {
    const { entries } = await native.readdir({ path })
    return entries.map((e) => ({ name: e.name, isFile: e.type === 'file', isDirectory: e.type === 'directory' }))
  },
  mtime: async (path) => (await native.stat({ path })).mtime,
  async exists(path) {
    try {
      await native.stat({ path })
      return true
    } catch (err) {
      if (errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR') return false
      throw err
    }
  },
  mkdir: (path, recursive = false) => native.mkdir({ path, recursive }),
  rename: (from, to) => native.rename({ from, to }),
  remove: (path) => native.remove({ path }),
  trash: (path) => native.remove({ path })
}

/** Errors that carry their code where Node puts it, so isomorphic-git can tell a missing file from a failure. */
async function coded<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (err) {
    const error = new Error(err instanceof Error ? err.message : String(err)) as Error & { code?: string }
    error.code = errorCode(err) ?? 'EIO'
    throw error
  }
}

/** A Node-like `Stats`, as much of it as isomorphic-git reads. */
function stats(entry: NativeEntry) {
  const isFile = entry.type === 'file'
  const isDirectory = entry.type === 'directory'
  return {
    type: entry.type === 'other' ? 'symlink' : entry.type,
    mode: isDirectory ? 0o40000 : 0o100644,
    size: entry.size,
    ino: 0,
    uid: 0,
    gid: 0,
    dev: 0,
    mtimeMs: entry.mtime,
    ctimeMs: entry.ctime,
    isFile: () => isFile,
    isDirectory: () => isDirectory,
    isSymbolicLink: () => entry.type === 'other'
  }
}

/** The promise-based `fs` isomorphic-git expects. */
export const gitFs = {
  promises: {
    async readFile(path: string, options?: { encoding?: string } | string) {
      const encoding = typeof options === 'string' ? options : options?.encoding
      if (encoding === 'utf8') return (await coded(native.readFile({ path, encoding: 'utf8' }))).data
      return fromBase64((await coded(native.readFile({ path }))).data)
    },
    async writeFile(path: string, data: Uint8Array | string) {
      if (typeof data === 'string') await coded(native.writeFile({ path, data, encoding: 'utf8' }))
      else await coded(native.writeFile({ path, data: toBase64(data) }))
    },
    mkdir: (path: string) => coded(native.mkdir({ path })),
    rmdir: (path: string) => coded(native.rmdir({ path })),
    unlink: (path: string) => coded(native.unlink({ path })),
    rm: (path: string) => coded(native.remove({ path })),
    stat: async (path: string) => stats(await coded(native.stat({ path }))),
    lstat: async (path: string) => stats(await coded(native.stat({ path }))),
    readdir: async (path: string) => (await coded(native.readdir({ path }))).entries.map((e) => e.name),
    async readlink(): Promise<never> {
      throw Object.assign(new Error('Symbolic links aren’t supported.'), { code: 'ENOENT' })
    },
    async symlink(): Promise<never> {
      throw Object.assign(new Error('Symbolic links aren’t supported.'), { code: 'EPERM' })
    }
  }
}
