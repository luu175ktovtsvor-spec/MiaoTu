// Runtime code and named Skill resources are copied without reading their
// contents. Keep examples/licenses (including hidden examples), but never stage
// known credentials, local databases or build/runtime state for distribution.
const excludedDirectories = ['node_modules', '.app', 'runtime', 'release', '.tools', '.git', '.hg', '.svn', '.oip', '.cache', '.vite', '__pycache__', 'reference-sources', 'secrets', '.ssh', '.aws', '.gnupg', '.kube']
const excludedNames = ['.ds_store', 'desktop.ini', '.npmrc', '.netrc', '.pypirc', '.git-credentials', '.yarnrc.yml', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'license', 'license.txt', 'notice', 'notices', 'third_party_notices.txt', 'package-lock.json']
const runtimeDirectories = ['db', 'data', 'workspace', 'backups', 'artifacts', 'coverage']
const desktopStateNames = ['computer-access.json', 'window.json']
const databaseExtensions = ['db', 'sqlite', 'sqlite3']
const privateExtensions = ['enc', 'key', 'pem', 'p12', 'pfx', 'jks', 'keystore']
const transientExtensions = ['log', 'download', 'tmp', 'bak', 'orig', 'pyc', 'pyo']
const environmentExamples = ['example', 'sample', 'template']
const database = new RegExp(`\\.(?:${databaseExtensions.join('|')})(?:-(?:wal|shm|journal))?(?:\\.gz)?$`)
const privateFile = new RegExp(`\\.(?:${privateExtensions.join('|')})$`)
const transient = new RegExp(`\\.(?:${transientExtensions.join('|')})(?:[.-].*)?$`)

export function isDesktopResourcePath(value: string) {
  const parts = value.replaceAll('\\', '/').toLowerCase().split('/').filter(part => part && part !== '.')
  if (parts.includes('..') || parts.some(part => excludedDirectories.includes(part))) return false
  // The signing driver runs in CI from source; it has no desktop runtime role.
  if (parts.join('/') === 'desktop/scripts/macos-signing.ts') return false
  if (['server', 'desktop'].includes(parts[0]) && runtimeDirectories.includes(parts[1])) return false
  const name = parts.at(-1) || ''
  if (excludedNames.includes(name) || database.test(name) || privateFile.test(name) || transient.test(name) || name.endsWith('~')) return false
  if (name === '.env' || name.startsWith('.env.') && !environmentExamples.includes(name.slice(5))) return false
  if (parts.length === 2 && parts[0] === 'desktop' && (desktopStateNames.includes(name) || /^catalog-.*\.json$/.test(name))) return false
  if (parts.at(-2) === 'settings' && name === 'providers.json') return false
  return true
}

// Same exclusions in electron-builder's .app-only file selection. Dependency
// packages outside .app retain the builder's normal production-module rules.
const globCase = (value: string) => value.replace(/[a-z]/g, letter => `[${letter}${letter.toUpperCase()}]`)
const alternatives = (values: string[]) => `{${values.map(globCase).join(',')}}`
export const desktopResourceExclusions = [
  `!.app/**/${alternatives(excludedDirectories)}{,/**/*}`,
  `!.app/{server,desktop}/${alternatives(runtimeDirectories)}{,/**/*}`,
  `!.app/**/${alternatives(excludedNames)}`,
  `!.app/**/*.${alternatives(databaseExtensions)}{,-${globCase('wal')},-${globCase('shm')},-${globCase('journal')}}{,.${globCase('gz')}}`,
  `!.app/**/*.${alternatives(privateExtensions)}`,
  `!.app/**/*.${alternatives(transientExtensions)}{,.*,-*}`,
  '!.app/**/*~',
  `!.app/**/.${globCase('env')}`,
  `!.app/**/.${globCase('env')}.!(${environmentExamples.map(globCase).join('|')})`,
  `!.app/desktop/${alternatives(desktopStateNames)}`,
  `!.app/desktop/${globCase('catalog')}-*.${globCase('json')}`,
  `!.app/**/${globCase('settings')}/${globCase('providers.json')}`,
]
