// Controlled CI-only Developer ID packaging. Never use the user's login keychain.
import { spawn } from 'node:child_process'
import { randomBytes, X509Certificate } from 'node:crypto'
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const desktop = fileURLToPath(new URL('../', import.meta.url))
const repository = resolve(desktop, '..')
const requireDesktop = createRequire(join(desktop, 'package.json'))
const repositoryName = 'luu175ktovtsvor-spec/MiaoTu'
const profile = 'miaoimg-release-notary'
const architectures = [{ name: 'arm64', binary: 'arm64', directory: 'mac-arm64' }, { name: 'x64', binary: 'x86_64', directory: 'mac' }]
type SigningState = { keychain: string; searchList: string[]; sha1?: string; team?: string }
type Proof = { commit?: string; startedAt: string; checks: Record<string, unknown>[]; stages: string[]; failure?: { stage: string; code: string; diagnostic?: ReturnType<typeof safeSigningDiagnostic> }; complete?: boolean; cleanup?: boolean }
type ExtractDiagnostic = { toolCode: keyof typeof extractMessages; exitCode?: number }
class SigningFailure extends Error { code: string; tool?: ExtractDiagnostic; constructor(code: string, tool?: ExtractDiagnostic) { super(code); this.code = code; this.tool = tool } }
const extractMessages = {
  codesign_extract_path_not_found: 'Certificate extraction target or prefix was not found; use --extract-certificates=<prefix>',
  codesign_extract_arguments_invalid: 'Certificate extraction arguments were rejected by codesign',
  codesign_extract_unsigned_target: 'Certificate extraction requires a signed code object',
  codesign_extract_output_permission_denied: 'Certificate extraction output directory is not writable',
  codesign_extract_chain_unavailable: 'Signing certificate chain could not be extracted',
  codesign_extract_interrupted: 'Certificate extraction was interrupted or timed out',
  codesign_extract_unknown_failure: 'Certificate extraction failed; raw tool output omitted',
} as const
const fail = (code: string): never => { throw new SigningFailure(code) }
let stage = 'initialization'
let proofWrites = Promise.resolve()

function paths() {
  const temp = process.env.RUNNER_TEMP, run = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT
  if (!temp || !/^\d+$/.test(run || '') || !/^\d+$/.test(attempt || '')) fail('missing_isolated_runner_context')
  const privateDirectory = join(resolve(temp), `miaoimg-macos-signing-${run}-${attempt}`)
  return { privateDirectory, preflightDirectory: privateDirectory + '-preflight', state: join(privateDirectory, 'state.json'), proofDirectory: join(resolve(temp), 'desktop-proof'), proof: join(resolve(temp), 'desktop-proof', 'macos-signing.json') }
}
function assertCi() {
  if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== repositoryName || process.env.GITHUB_REF !== 'refs/heads/ChineseMain' || !/^[a-f\d]{40}$/i.test(process.env.GITHUB_SHA || '')) fail('controlled_macos_release_context_required')
}
function required(name: string) { const value = process.env[name]; if (!value?.trim()) fail(`missing_${name}`); return value }
async function exists(path: string) { return access(path).then(() => true, () => false) }
async function readState(): Promise<SigningState> { return JSON.parse(await readFile(paths().state, 'utf8')) }
async function saveState(value: SigningState) { await writeFile(paths().state, JSON.stringify(value), { mode: 0o600 }) }
async function proof(): Promise<Proof> {
  try { return JSON.parse(await readFile(paths().proof, 'utf8')) }
  catch { return { commit: process.env.GITHUB_SHA, startedAt: new Date().toISOString(), checks: [], stages: [] } }
}
async function record(check: Record<string, unknown>) {
  // Builder may sign the two architectures concurrently. Keep both receipts.
  const next = proofWrites.then(async () => {
    const value = await proof(); value.checks.push(check)
    await mkdir(paths().proofDirectory, { recursive: true }); await writeFile(paths().proof, JSON.stringify(value, null, 2) + '\n')
  })
  proofWrites = next.catch(() => {})
  await next
}
async function command(file: string, args: string[], label: string, options: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(file, args, { cwd: options.cwd || repository, env: options.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', overflow = false
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout || 120_000)
    const collect = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      if (stdout.length + stderr.length + chunk.length > 8 * 1024 * 1024) { overflow = true; child.kill('SIGKILL'); return }
      if (kind === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString()
    }
    child.stdout.on('data', chunk => collect('stdout', chunk)); child.stderr.on('data', chunk => collect('stderr', chunk))
    child.on('error', () => { clearTimeout(timer); reject(new SigningFailure(`${label}_could_not_start`)) })
    child.on('close', code => {
      clearTimeout(timer)
      const extractsCertificate = file === '/usr/bin/codesign' && args.some(arg => arg === '--extract-certificates' || arg.startsWith('--extract-certificates='))
      code === 0 && !overflow ? done({ stdout, stderr }) : reject(new SigningFailure(`${label}_failed`, extractsCertificate ? classifyCertificateExtraction(stderr, code) : undefined))
    })
  })
}

export function certificateExtractionArguments(prefix: string, app: string) {
  // codesign's prefix is an optional long-option argument: it requires '='.
  return ['--display', `--extract-certificates=${prefix}`, app]
}
export function classifyCertificateExtraction(stderr: string, exitCode: number | null): ExtractDiagnostic {
  let toolCode: ExtractDiagnostic['toolCode'] = 'codesign_extract_unknown_failure'
  if (exitCode === null) toolCode = 'codesign_extract_interrupted'
  else if (/No such file or directory/i.test(stderr)) toolCode = 'codesign_extract_path_not_found'
  else if (/Usage:\s*codesign|unknown option|unrecognized option|invalid argument|option.*requires/i.test(stderr)) toolCode = 'codesign_extract_arguments_invalid'
  else if (/not signed at all|code object is not signed/i.test(stderr)) toolCode = 'codesign_extract_unsigned_target'
  else if (/Permission denied|Operation not permitted|Read-only file system/i.test(stderr)) toolCode = 'codesign_extract_output_permission_denied'
  else if (/no certificates|cannot extract|unable to extract|does not contain.*certificate/i.test(stderr)) toolCode = 'codesign_extract_chain_unavailable'
  return { toolCode, ...(Number.isInteger(exitCode) && exitCode! >= 0 && exitCode! <= 255 ? { exitCode: exitCode! } : {}) }
}

export function certificateIdentity(pem: string, team: string, now = Date.now()) {
  const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []
  const candidates = certificates.map(value => new X509Certificate(value)).filter(cert => /(?:^|\n)CN=Developer ID Application:/.test(cert.subject) && cert.subject.split('\n').includes(`OU=${team}`) && /(?:^|\n)CN=Developer ID Certification Authority(?:\n|$)/.test(cert.issuer) && cert.issuer.split('\n').includes('OU=G2'))
  if (candidates.length !== 1) fail('exactly_one_matching_G2_certificate_required')
  const certificate = candidates[0]
  if (!(Date.parse(certificate.validFrom) <= now && Date.parse(certificate.validTo) > now)) fail('signing_certificate_not_currently_valid')
  const sha1 = certificate.fingerprint.replaceAll(':', '').toUpperCase()
  if (!/^[A-F\d]{40}$/.test(sha1)) fail('invalid_certificate_fingerprint')
  return { certificate, sha1 }
}

async function preflight() {
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'MIAO_ACCEPT_EMAIL', 'MIAO_ACCEPT_PASSWORD']) required(name)
  const team = required('APPLE_TEAM_ID'), encoded = required('CSC_LINK').replace(/\s/g, '')
  if (!/^[A-Z\d]{10}$/.test(team) || !/^[A-Za-z\d+/]+={0,2}$/.test(encoded)) fail('invalid_signing_configuration')
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) fail('invalid_p12_size')
  const directory = paths().preflightDirectory
  if (await exists(directory)) fail('preflight_directory_already_exists')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    const p12 = join(directory, 'identity.p12'); await writeFile(p12, bytes, { mode: 0o600 })
    const exported = await command('/usr/bin/openssl', ['pkcs12', '-in', p12, '-clcerts', '-nokeys', '-passin', 'env:CSC_KEY_PASSWORD'], 'preflight_public_p12_certificate')
    const { certificate, sha1 } = certificateIdentity(exported.stdout, team)
    await record({ stage: 'preflight', certificateSha1: sha1, issuer: 'Developer ID G2', expiresAt: certificate.validTo, secretsPresent: true, keychainNotImportedBeforeDependencies: true })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

async function prepare() {
  const secrets = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'MIAO_ACCEPT_EMAIL', 'MIAO_ACCEPT_PASSWORD']
  for (const secret of secrets) required(secret)
  const team = required('APPLE_TEAM_ID')
  if (!/^[A-Z\d]{10}$/.test(team)) fail('invalid_apple_team_identifier')
  if (await exists(paths().privateDirectory)) fail('signing_directory_already_exists')
  await mkdir(paths().privateDirectory, { recursive: true, mode: 0o700 }); await chmod(paths().privateDirectory, 0o700)
  const encoded = required('CSC_LINK').replace(/\s/g, '')
  if (!/^[A-Za-z\d+/]+={0,2}$/.test(encoded)) fail('CSC_LINK_must_be_base64_p12')
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) fail('invalid_p12_size')
  const p12 = join(paths().privateDirectory, 'identity.p12'), leaf = join(paths().privateDirectory, 'identity.pem')
  await writeFile(p12, bytes, { mode: 0o600 })
  const exported = await command('/usr/bin/openssl', ['pkcs12', '-in', p12, '-clcerts', '-nokeys', '-passin', 'env:CSC_KEY_PASSWORD'], 'read_public_p12_certificate')
  const { certificate, sha1 } = certificateIdentity(exported.stdout, team)
  const checked = (await proof()).checks.find(check => check.stage === 'preflight')
  if (!checked || checked.certificateSha1 !== sha1) fail('signing_identity_changed_after_preflight')
  await writeFile(leaf, certificate.toString(), { mode: 0o600 })
  const previous = await command('/usr/bin/security', ['list-keychains', '-d', 'user'], 'read_runner_keychain_search_list')
  const searchList = [...previous.stdout.matchAll(/"([^"]+)"/g)].map(match => match[1])
  const keychain = join(paths().privateDirectory, 'identity.keychain-db'), state: SigningState = { keychain, searchList, sha1, team }
  await saveState(state) // Enables cleanup even if an import or Apple validation fails.
  const password = randomBytes(32).toString('hex')
  await command('/usr/bin/security', ['create-keychain', '-p', password, keychain], 'create_isolated_keychain')
  await command('/usr/bin/security', ['set-keychain-settings', '-lut', '14400', keychain], 'set_isolated_keychain_timeout')
  await command('/usr/bin/security', ['unlock-keychain', '-p', password, keychain], 'unlock_isolated_keychain')
  await command('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', keychain, ...searchList], 'add_isolated_keychain_to_search_list')
  // Public G2 intermediate from Apple's PKI list; import only into this job's keychain.
  const caResponse = await fetch('https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer', { redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (!caResponse.ok) fail('apple_G2_intermediate_unavailable')
  const caBytes = Buffer.from(await caResponse.arrayBuffer()), ca = new X509Certificate(caBytes)
  if (!ca.subject.split('\n').includes('OU=G2') || !certificate.checkIssued(ca) || !certificate.verify(ca.publicKey)) fail('G2_intermediate_does_not_match_leaf')
  const caPath = join(paths().privateDirectory, 'DeveloperIDG2CA.cer'); await writeFile(caPath, caBytes, { mode: 0o600 })
  await command('/usr/bin/security', ['import', caPath, '-k', keychain], 'import_public_G2_intermediate')
  await command('/usr/bin/security', ['import', p12, '-k', keychain, '-P', required('CSC_KEY_PASSWORD'), '-T', '/usr/bin/codesign', '-T', '/usr/bin/security', '-f', 'pkcs12'], 'import_G2_private_identity')
  await command('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain], 'allow_automated_codesign')
  const identities = await command('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', keychain], 'verify_imported_identity')
  const hashes = [...identities.stdout.matchAll(/\b([A-F\d]{40})\s+"/gi)].map(match => match[1].toUpperCase())
  if (hashes.length !== 1 || hashes[0] !== sha1) fail('isolated_keychain_identity_mismatch')
  await command('/usr/bin/security', ['verify-cert', '-c', leaf, '-c', caPath, '-p', 'codeSign'], 'verify_apple_certificate_chain')
  await command('/usr/bin/xcrun', ['notarytool', 'store-credentials', profile, '--keychain', keychain, '--apple-id', required('APPLE_ID'), '--team-id', team, '--password', required('APPLE_APP_SPECIFIC_PASSWORD'), '--validate'], 'validate_and_store_notary_profile')
  await rm(p12, { force: true })
  await record({ stage: 'prepare', certificateSha1: sha1, certificateChain: 'Developer ID G2', expiresAt: certificate.validTo, isolatedSigningIdentityCount: 1, appleCredentialsValidated: true })
}

async function verifyApplication(app: string, architecture: string, label: string) {
  const state = await readState(), metadata = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'))
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], `${label}_signature`)
  const display = await command('/usr/bin/codesign', ['--display', '--verbose=4', app], `${label}_signature_details`)
  const details = display.stdout + display.stderr
  if (!details.includes(`TeamIdentifier=${state.team}`) || !details.includes('Authority=Developer ID Application:') || !/flags=.*\(.*runtime.*\)/.test(details) || !/Timestamp=/.test(details)) fail(`${label}_distribution_signature_required`)
  const prefix = join(paths().privateDirectory, `certificate-${label.replace(/[^a-z\d-]/gi, '-')}-`)
  await command('/usr/bin/codesign', certificateExtractionArguments(prefix, app), `${label}_extract_signing_certificate`)
  const cert = new X509Certificate(await readFile(prefix + '0'))
  if (cert.fingerprint.replaceAll(':', '').toUpperCase() !== state.sha1 || !cert.issuer.split('\n').includes('OU=G2')) fail(`${label}_wrong_signing_certificate`)
  const info = join(app, 'Contents', 'Info.plist')
  const plist = async (key: string) => (await command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, info], `${label}_plist`)).stdout.trim()
  if (await plist('CFBundleIdentifier') !== metadata.build.appId || await plist('CFBundleShortVersionString') !== metadata.version) fail(`${label}_bundle_metadata_mismatch`)
  const executable = await plist('CFBundleExecutable')
  if (!executable || basename(executable) !== executable) fail(`${label}_invalid_executable`)
  const arch = (await command('/usr/bin/lipo', ['-archs', join(app, 'Contents', 'MacOS', executable)], `${label}_architecture`)).stdout.trim()
  if (arch !== architecture) fail(`${label}_wrong_architecture`)
  const { extractFile } = requireDesktop('@electron/asar')
  const packaged = JSON.parse(extractFile(join(app, 'Contents', 'Resources', 'app.asar'), '.app/desktop/package.json').toString())
  if (packaged.macCredentialProtection !== metadata.macCredentialProtection || packaged.macCredentialProtection !== 'local-key') fail(`${label}_credential_protection_changed`)
  await command('/usr/bin/xcrun', ['stapler', 'validate', '-v', app], `${label}_app_ticket`)
  await command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app], `${label}_app_gatekeeper`)
  await record({ stage, label, architecture, certificateSha1: state.sha1, credentialProtection: 'local-key', deepStrictSignature: true, hardenedRuntime: true, timestamp: true, notarization: 'Accepted by electron-notarize before afterSign', stapled: true, gatekeeper: 'accepted' })
}

export function signedBuilderConfig(sha1: string, sign: (options: any) => Promise<void>, afterSign: (context: any) => Promise<void>) {
  if (!/^[A-F\d]{40}$/.test(sha1)) fail('explicit_certificate_SHA1_required')
  return { forceCodeSigning: true, mac: { identity: sha1, type: 'distribution', hardenedRuntime: true, notarize: true, sign }, dmg: { sign: true }, afterSign }
}

// Builder's relative lifecycle hooks use process.cwd(), even with projectDir.
// Match the former `npm --prefix desktop run package:mac` working directory.
export async function withDesktopBuildDirectory<T>(action: () => Promise<T>): Promise<T> {
  const previous = process.cwd()
  process.chdir(desktop)
  try { return await action() } finally { process.chdir(previous) }
}

export function safeSigningDiagnostic(error: unknown) {
  const value = error as { name?: unknown; code?: unknown; message?: unknown; errors?: unknown }
  const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AggregateError', 'ValidationError', 'InvalidConfigurationError', 'SigningFailure', 'ExecError', 'TimeoutError', 'AbortError'])
  const codes = new Set(['ERR_ELECTRON_BUILDER_INVALID_CONFIGURATION', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_REQUIRE_ESM', 'ERR_REQUIRE_ASYNC_MODULE', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_UNKNOWN_FILE_EXTENSION', 'ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ENOSPC', 'ETIMEDOUT', 'ECONNRESET', 'ENOEXEC', 'ENOTFOUND'])
  const type = typeof value?.name === 'string' && names.has(value.name) ? value.name : 'Error'
  const code = error instanceof SigningFailure ? error.code : typeof value?.code === 'string' && codes.has(value.code) ? value.code : undefined
  const raw = typeof value?.message === 'string' ? value.message : ''
  // Never copy a raw message, argv, schema data/params, cause or stack. These
  // exact schema paths and constant messages are safe even for tool failures.
  const knownPaths = ['mac', 'mac.identity', 'mac.sign', 'mac.notarize', 'mac.type', 'mac.hardenedRuntime', 'mac.entitlements', 'mac.entitlementsInherit', 'dmg', 'dmg.sign', 'forceCodeSigning', 'afterPack', 'afterSign', 'directories', 'directories.app', 'directories.output', 'files', 'publish', 'appId', 'productName', 'electronVersion', 'extraMetadata', 'asar']
  const schemaPaths = new Set<string>()
  let message = 'Unclassified packaging failure; raw tool output omitted'
  if (error instanceof SigningFailure) message = error.tool ? extractMessages[error.tool.toolCode] : 'Controlled release verification failed'
  else if (/Hook module path[\s\S]*resolves outside[\s\S]*workspace root/.test(raw)) {
    message = 'Configured build hook resolves outside the desktop workspace'
    if (raw.includes('windows-resources.js')) schemaPaths.add('/afterPack')
  } else if (/Invalid configuration object\./.test(raw)) {
    message = 'electron-builder rejected the configuration schema'
    for (const match of raw.matchAll(/\bconfiguration\.([A-Za-z][A-Za-z\d]*(?:\.[A-Za-z][A-Za-z\d]*)*)/g)) if (knownPaths.includes(match[1])) schemaPaths.add('/' + match[1].replaceAll('.', '/'))
  } else if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || /Cannot find (?:module|package)/.test(raw)) message = 'Build hook or dependency module could not be resolved'
  else if (/Cannot find package\.json/.test(raw)) message = 'Application package metadata was not found'
  else if (/notari[sz]|notarytool/i.test(raw)) message = 'Apple notarization operation failed'
  else if (/No identity found for signing|cannot find valid.*identity|Identity name is specified/i.test(raw)) message = 'Signing identity was not found in the isolated keychain'
  else if (code === 'ERR_INVALID_ARG_TYPE' || code === 'ERR_INVALID_ARG_VALUE') message = 'Build API received an invalid argument type or value'
  if (Array.isArray(value?.errors)) for (const item of value.errors) {
    const path = typeof item?.instancePath === 'string' ? item.instancePath : ''
    if (knownPaths.some(known => path === '/' + known.replaceAll('.', '/'))) schemaPaths.add(path)
  }
  return { type, ...(code ? { code } : {}), ...(schemaPaths.size ? { schemaPaths: [...schemaPaths] } : {}), ...(error instanceof SigningFailure && error.tool ? error.tool : {}), message }
}

export function assertVerifiedBuildProof(value: Proof, commit: string, certificateSha1: string) {
  if (value.failure) fail('build_has_recorded_failure')
  if (value.commit !== commit || !/^[a-f\d]{40}$/i.test(commit)) fail('build_receipt_commit_mismatch')
  if (!/^[A-F\d]{40}$/.test(certificateSha1)) fail('build_receipt_certificate_missing')
  if (!value.stages.includes('build')) fail('build_completion_receipt_missing')
  for (const arch of architectures) {
    const receipt = value.checks.find(check => check.stage === 'build' && check.label === `before-archive-${arch.binary}` && check.architecture === arch.binary)
    if (!receipt || receipt.certificateSha1 !== certificateSha1 || receipt.credentialProtection !== 'local-key'
      || receipt.deepStrictSignature !== true || receipt.hardenedRuntime !== true || receipt.timestamp !== true || receipt.stapled !== true || receipt.gatekeeper !== 'accepted'
      || receipt.notarization !== 'Accepted by electron-notarize before afterSign') fail(`before_archive_receipt_missing_${arch.name}`)
  }
  const completion = value.checks.find(check => check.stage === 'build' && check.appTicketBeforeZip === true && Array.isArray(check.verifiedArchitectures)
    && check.verifiedArchitectures.length === 2 && architectures.every(arch => (check.verifiedArchitectures as unknown[]).includes(arch.binary)))
  if (!completion) fail('both_architectures_build_receipt_missing')
}
async function verifyBuild() {
  const state = await readState()
  assertVerifiedBuildProof(await proof(), required('GITHUB_SHA'), state.sha1 || '')
}

export function preserveFirstSigningFailure(value: Proof, attempted: NonNullable<Proof['failure']>) {
  if (!value.failure) value.failure = attempted
  else value.checks.push({ stage: attempted.stage, blockedByPrimaryFailure: true, diagnostic: attempted.diagnostic })
  return value
}

async function build() {
  const state = await readState()
  if (!state.sha1 || !state.team || !await exists(state.keychain)) fail('prepared_signing_identity_required')
  // Never let builder re-import CSC_LINK or choose a same-named old certificate.
  delete process.env.CSC_LINK; delete process.env.CSC_KEY_PASSWORD; delete process.env.APPLE_ID; delete process.env.APPLE_TEAM_ID; delete process.env.APPLE_APP_SPECIFIC_PASSWORD; delete process.env.DEBUG
  delete process.env.APPLE_API_KEY; delete process.env.APPLE_API_KEY_ID; delete process.env.APPLE_API_ISSUER
  process.env.CSC_KEYCHAIN = state.keychain; process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  process.env.APPLE_KEYCHAIN = state.keychain; process.env.APPLE_KEYCHAIN_PROFILE = profile
  const { build: packageApp, Platform, Arch } = requireDesktop('electron-builder'), { signAsync } = requireDesktop('@electron/osx-sign')
  const signed = new Set<string>()
  await record({ stage: 'build', builderWorkingDirectory: 'desktop', relativeHooksResolveFromProject: true })
  await withDesktopBuildDirectory(() => packageApp({ projectDir: desktop, publish: 'never', targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch.arm64, Arch.x64), config: signedBuilderConfig(state.sha1,
    async options => { if (options.keychain !== state.keychain || options.identity !== state.sha1) fail('builder_signing_identity_changed'); await signAsync({ ...options, identity: state.sha1, keychain: state.keychain, identityValidation: false }) },
    async context => {
      const architecture = context.arch === Arch.arm64 ? 'arm64' : context.arch === Arch.x64 ? 'x86_64' : fail('unexpected_packaging_architecture')
      await verifyApplication(join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`), architecture, `before-archive-${architecture}`)
      signed.add(architecture)
    }) }))
  if (signed.size !== 2) fail('both_apps_must_pass_before_archive_hook')
  await record({ stage: 'build', verifiedArchitectures: [...signed], appTicketBeforeZip: true })
}

async function verifyDmg(path: string, architecture: string) {
  const state = await readState(), name = basename(path)
  await command('/usr/bin/codesign', ['--force', '--sign', state.sha1!, '--keychain', state.keychain, '--timestamp', path], 'sign_final_dmg')
  const submit = await command('/usr/bin/xcrun', ['notarytool', 'submit', path, '--keychain-profile', profile, '--keychain', state.keychain, '--wait', '--timeout', '30m', '--output-format', 'json'], 'notarize_dmg', { timeout: 32 * 60_000 })
  let receipt: any; try { receipt = JSON.parse(submit.stdout) } catch { fail('invalid_dmg_notary_response') }
  if (receipt.status !== 'Accepted' || typeof receipt.id !== 'string' || !/^[a-f\d-]{36}$/i.test(receipt.id)) fail('dmg_notary_not_accepted')
  await record({ stage, artifact: name, notarization: receipt.status, submissionId: receipt.id })
  await command('/usr/bin/xcrun', ['stapler', 'staple', '-v', path], 'staple_dmg')
  await command('/usr/bin/xcrun', ['stapler', 'validate', '-v', path], 'validate_dmg_ticket')
  await command('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', path], 'verify_dmg_signature')
  await command('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', path], 'assess_dmg_gatekeeper')
  const mount = join(paths().privateDirectory, `mount-${architecture}`); await mkdir(mount)
  let mounted = false
  try {
    await command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, path], 'mount_final_dmg'); mounted = true
    const metadata = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'))
    await verifyApplication(join(mount, `${metadata.productName}.app`), architecture, `dmg-${architecture}`)
  } finally { if (mounted) await command('/usr/bin/hdiutil', ['detach', mount], 'detach_final_dmg') }
  await record({ stage, artifact: name, dmgSignature: true, stapled: true, gatekeeper: 'accepted' })
}

export async function refreshUpdateMetadata(directory: string, expectedVersion: string, expectedArtifacts: string[], buildBlockMap: (file: string, format: string, output: string) => Promise<{ sha512: string; size: number }>, yaml: any) {
  const metadataFile = join(directory, 'latest-mac.yml'), metadata = yaml.load(await readFile(metadataFile, 'utf8'))
  if (metadata?.version !== expectedVersion || !Array.isArray(metadata.files) || metadata.files.length !== expectedArtifacts.length) fail('unexpected_update_metadata')
  const expected = new Set(expectedArtifacts), seen = new Set<string>()
  for (const entry of metadata.files) {
    if (!expected.has(entry.url) || seen.has(entry.url) || basename(entry.url) !== entry.url) fail('unexpected_update_artifact')
    seen.add(entry.url)
  }
  if (!seen.has(metadata.path) || !metadata.path.endsWith('.zip')) fail('updater_primary_path_must_be_verified_zip')
  const files = []
  for (const entry of metadata.files) {
    // This is the exact external gzip blockmap API used by builder 26.15.3.
    const info = await buildBlockMap(join(directory, entry.url), 'gzip', join(directory, `${entry.url}.blockmap`))
    const { sha512: _oldHash, size: _oldSize, blockMapSize: _embeddedSize, ...extra } = entry
    files.push({ url: entry.url, sha512: info.sha512, size: info.size, ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'url')) })
  }
  metadata.files = files; metadata.sha512 = files.find(entry => entry.url === metadata.path)!.sha512
  await writeFile(metadataFile, yaml.dump(metadata, { lineWidth: -1, noRefs: true }))
  return metadata
}

async function finalize() {
  // No builder imports here: a zero exit code altered by a dependency's exit
  // hook cannot substitute for completed verification of both architectures.
  await verifyBuild()
  const metadata = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8')), release = join(desktop, 'release'), artifacts: string[] = []
  for (const arch of architectures) {
    const stem = `${metadata.productName}-${metadata.version}-${arch.name}`, app = join(release, arch.directory, `${metadata.productName}.app`)
    await verifyApplication(app, arch.binary, `built-${arch.name}`)
    const extracted = join(paths().privateDirectory, `zip-${arch.name}`); await mkdir(extracted)
    await command('/usr/bin/ditto', ['-x', '-k', join(release, stem + '.zip'), extracted], 'extract_final_zip')
    await verifyApplication(join(extracted, `${metadata.productName}.app`), arch.binary, `zip-${arch.name}`)
    await verifyDmg(join(release, stem + '.dmg'), arch.binary)
    artifacts.push(stem + '.zip', stem + '.dmg')
  }
  const yaml = requireDesktop('js-yaml'), { buildBlockMap } = requireDesktop('app-builder-lib/out/targets/blockmap/blockmap.js')
  const latest = await refreshUpdateMetadata(release, metadata.version, artifacts, buildBlockMap, yaml)
  await command('python3', [join(repository, 'deploy/verify-update-metadata.py'), metadata.version, 'latest-mac.yml'], 'verify_final_update_metadata', { cwd: release })
  const publish = join(release, 'publish')
  if (await exists(publish)) fail('publish_directory_must_start_empty')
  await mkdir(publish)
  const publicName = (name: string) => name.replace(`${metadata.productName}-`, `${repositoryName.split('/')[1]}-`) // GitHub strips non-ASCII asset characters; official downloads retain productName.
  for (const artifact of artifacts) for (const suffix of ['', '.blockmap']) await copyFile(join(release, artifact + suffix), join(publish, publicName(artifact) + suffix))
  latest.files = latest.files.map(entry => ({ ...entry, url: publicName(entry.url) })); latest.path = publicName(latest.path)
  await writeFile(join(publish, 'latest-mac.yml'), yaml.dump(latest, { lineWidth: -1, noRefs: true }))
  await command('python3', [join(repository, 'deploy/verify-update-metadata.py'), metadata.version, 'latest-mac.yml'], 'verify_public_update_metadata', { cwd: publish })
  await record({ stage: 'finalize', artifacts: artifacts.map(publicName), finalBlockmapsRebuilt: true, updateMetadataVerified: true })
  const value = await proof(); value.complete = true; await writeFile(paths().proof, JSON.stringify(value, null, 2) + '\n')
}

async function cleanup() {
  let problem = false
  if (await exists(paths().state)) {
    const state = await readState()
    // Mounted images can survive an interrupted finalizer; detach only our paths.
    for (const arch of architectures) {
      const mount = join(paths().privateDirectory, `mount-${arch.binary}`)
      if (await exists(mount)) await command('/usr/bin/hdiutil', ['detach', mount], 'cleanup_dmg_mount').catch(async () => {
        // An empty mount directory also returns an error; inspect only this
        // helper's mount path before attempting a force detach.
        const info = await command('/usr/bin/hdiutil', ['info', '-plist'], 'inspect_cleanup_mounts')
        if (info.stdout.includes(mount)) await command('/usr/bin/hdiutil', ['detach', '-force', mount], 'force_cleanup_dmg_mount')
      }).catch(() => { problem = true })
    }
    await command('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...state.searchList], 'restore_runner_keychain_search_list').catch(() => { problem = true })
    if (await exists(state.keychain)) await command('/usr/bin/security', ['delete-keychain', state.keychain], 'delete_isolated_keychain').catch(() => { problem = true })
  }
  await rm(join(paths().privateDirectory, 'identity.p12'), { force: true })
  await rm(paths().privateDirectory, { recursive: true, force: true })
  await rm(paths().preflightDirectory, { recursive: true, force: true })
  const value = await proof(); value.cleanup = !problem; await mkdir(paths().proofDirectory, { recursive: true }); await writeFile(paths().proof, JSON.stringify(value, null, 2) + '\n')
  if (problem) fail('isolated_keychain_cleanup_failed')
}

async function sanitizedProof() {
  const directory = paths().proofDirectory, safe = join(directory, 'sanitized'); await mkdir(safe, { recursive: true })
  if (await exists(paths().proof)) await copyFile(paths().proof, join(safe, 'macos-signing.json'))
  const acceptance = join(directory, 'result.json')
  if (await exists(acceptance)) {
    const raw = JSON.parse(await readFile(acceptance, 'utf8'))
    // Deliberate allowlist: no screenshots, raw error text, app logs or profile.
    await writeFile(join(safe, 'acceptance.json'), JSON.stringify({ platform: raw.platform, startedAt: raw.startedAt, finishedAt: raw.finishedAt, ok: raw.ok === true, version: raw.version, checks: Array.isArray(raw.checks) ? raw.checks.filter(check => typeof check === 'string' && check.length < 300) : [], ...(raw.ok ? {} : { error: 'native_acceptance_failed' }) }, null, 2) + '\n')
  }
}

async function main(action: string) {
  assertCi(); stage = action
  try {
    if (action === 'preflight') await preflight()
    else if (action === 'prepare') await prepare()
    else if (action === 'build') await build()
    else if (action === 'verify-build') await verifyBuild()
    else if (action === 'finalize') await finalize()
    else if (action === 'cleanup') await cleanup()
    else if (action === 'proof') await sanitizedProof()
    else fail('unknown_signing_stage')
    if (action !== 'proof') { const value = await proof(); value.stages.push(action); await mkdir(paths().proofDirectory, { recursive: true }); await writeFile(paths().proof, JSON.stringify(value, null, 2) + '\n') }
  } catch (error) {
    const diagnostic = safeSigningDiagnostic(error)
    const value = preserveFirstSigningFailure(await proof(), { stage, code: diagnostic.code || 'signing_or_packaging_failed', diagnostic })
    await mkdir(paths().proofDirectory, { recursive: true }); await writeFile(paths().proof, JSON.stringify(value, null, 2) + '\n')
    // Do not print child-process arguments, Apple account errors or secret values.
    console.error(`macOS release stage failed: ${JSON.stringify(value.failure)}`); process.exitCode = 1
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main(process.argv[2] || '')
