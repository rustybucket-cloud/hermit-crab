import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The version of an iOS web bundle, for live updates (src/mobile/updates.ts):
 * `<commit time>-<commit>-<native code>`, such as `20261012153012-3b8cd5f-0f3a9c2e41d7`.
 *
 * The commit time, as UTC digits, orders bundles. The native code is a hash of everything that
 * needs a new App Store build to change: the app's Swift, project and plist files, and the
 * installed Capacitor plugins. A bundle only goes to apps whose native code it was built with.
 */
export function bundleVersion(root: string): string {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const time = new Date(Number(git('log', '-1', '--format=%ct')) * 1000)
  const stamp = time.toISOString().replace(/\D/g, '').slice(0, 14)
  return `${stamp}-${git('rev-parse', '--short=7', 'HEAD')}-${nativeHash(root, git)}`
}

function nativeHash(root: string, git: (...args: string[]) => string): string {
  const hash = createHash('sha256')
  const { dependencies } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  for (const name of Object.keys(dependencies).sort()) {
    if (!/^@(capacitor|capgo)\//.test(name)) continue
    const { version } = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'))
    hash.update(`${name}@${version}\n`)
  }
  // CapApp-SPM is left out: `cap sync` writes it from the plugins above.
  for (const file of git('ls-files', 'ios/App/App', 'ios/App/App.xcodeproj').split('\n').sort()) {
    hash.update(`${file}\n`).update(readFileSync(join(root, file)))
  }
  return hash.digest('hex').slice(0, 12)
}
