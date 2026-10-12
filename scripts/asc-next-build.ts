import { sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Prints the next build number for the iOS app: one higher than every build uploaded to App Store
 * Connect, so an upload is never turned away for reusing a number. Reads the API key the same way
 * scripts/ios-release.sh does: ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH.
 */
const BUNDLE_ID = 'com.rustybucket.hermitcrab'
const API = 'https://api.appstoreconnect.apple.com'

const keyId = required('ASC_KEY_ID')
const issuer = required('ASC_ISSUER_ID')
const keyPath = process.env.ASC_KEY_PATH || join(homedir(), '.appstoreconnect/private_keys', `AuthKey_${keyId}.p8`)
const token = jwt(readFileSync(keyPath, 'utf8'))

type Page<Attributes> = { data: { id: string; attributes: Attributes }[]; links?: { next?: string } }

const apps = await get<Page<{ bundleId: string }>>(`${API}/v1/apps?filter[bundleId]=${BUNDLE_ID}&fields[apps]=bundleId`)
const app = apps.data.find((app) => app.attributes.bundleId === BUNDLE_ID)
if (!app) throw new Error(`No app with bundle ID ${BUNDLE_ID} in App Store Connect.`)

let highest = 0
let next: string | undefined = `${API}/v1/builds?filter[app]=${app.id}&fields[builds]=version&limit=200`
while (next) {
  const page: Page<{ version: string }> = await get(next)
  for (const build of page.data) highest = Math.max(highest, Number(build.attributes.version) || 0)
  next = page.links?.next
}
console.log(highest + 1)

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name}.`)
  return value
}

/** A token for the App Store Connect API, good for 10 minutes. */
function jwt(key: string): string {
  const now = Math.floor(Date.now() / 1000)
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const body = `${part({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${part({ iss: issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })}`
  const signature = sign('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' })
  return `${body}.${signature.toString('base64url')}`
}

async function get<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error(`App Store Connect: ${response.status} ${await response.text()}`)
  return (await response.json()) as T
}
