// Controlled CI-only Developer ID packaging. Never use the user's login keychain.
import { spawn } from 'node:child_process'
import { randomBytes, X509Certificate } from 'node:crypto'
import { access, chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const desktop = fileURLToPath(new URL('../', import.meta.url))
const repository = resolve(desktop, '..')
const requireDesktop = createRequire(join(desktop, 'package.json'))
const repositoryName = 'luu175ktovtsvor-spec/MiaoTu'
const profile = 'miaoimg-release-notary'
const architectures = [{ name: 'arm64', binary: 'arm64', directory: 'mac-arm64' }, { name: 'x64', binary: 'x86_64', directory: 'mac' }]
type SigningState = { keychain: string; searchList: string[]; sha1?: string; team?: string }
type TicketTransportState = { anchor: string; ruleFile: string; mainRules: string; anchorCleared?: boolean; enableAttempted?: boolean; token?: string; tokenReleased?: boolean }
type TicketPf = (args: string[]) => Promise<{ stdout: string; stderr: string }>
type SaveTicketTransport = (state: TicketTransportState) => Promise<void>
export const ticketTransportRule = 'block return out quick proto udp from any to any port 443 label "miaoimg-staple"\n'
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
const signingMessages = {
  codesign_keychain_interaction_denied: 'codesign could not access the signing identity without interaction',
  codesign_keychain_internal_error: 'codesign reported an internal keychain signing error',
  codesign_identity_or_chain_unavailable: 'codesign could not use the identity or its certificate chain',
  codesign_timestamp_unavailable: 'codesign could not obtain a trusted timestamp',
  codesign_signature_invalid: 'codesign reported invalid or incomplete signed resources',
  codesign_entitlements_invalid: 'codesign rejected the entitlements',
  codesign_bundle_format_invalid: 'codesign rejected a bundle or code object format',
  codesign_extended_attributes_rejected: 'codesign rejected resource-fork or Finder metadata',
  codesign_command_failed: 'codesign failed; raw command and tool output omitted',
  notary_signature_preflight_failed: 'electron-notarize rejected the existing code signature before submission',
  notary_archive_failed: 'electron-notarize could not create its submission archive',
  notary_submit_failed: 'Apple notarization submission or processing failed',
  notary_staple_failed: 'electron-notarize could not staple the returned ticket',
  notary_tool_unavailable: 'The notarization command-line tool was unavailable',
} as const
type BuildBoundary = 'signAsync' | 'builder-notarization' | 'afterSign' | 'verified'
const buildApplications = new Map<string, { app: string; boundary: BuildBoundary }>()
const fail = (code: string): never => { throw new SigningFailure(code) }
let stage = 'initialization'
let proofWrites = Promise.resolve()

function paths() {
  const temp = process.env.RUNNER_TEMP, run = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT
  if (!temp || !/^\d+$/.test(run || '') || !/^\d+$/.test(attempt || '')) fail('missing_isolated_runner_context')
  const privateDirectory = join(resolve(temp), `miaoimg-macos-signing-${run}-${attempt}`)
  return { privateDirectory, preflightDirectory: privateDirectory + '-preflight', state: join(privateDirectory, 'state.json'), networkState: privateDirectory + '-network.json', networkRule: privateDirectory + '-network.rules', proofDirectory: join(resolve(temp), 'desktop-proof'), proof: join(resolve(temp), 'desktop-proof', 'macos-signing.json') }
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

function validTransportAnchor(anchor: string) { return /^com\.apple\/miaoimg-staple-\d{1,20}-\d{1,6}-[a-f\d]{8}$/.test(anchor) && anchor.length < 64 }
function validTransportToken(token: string) { return /^\d{1,20}$/.test(token) && BigInt(token) > 0n && BigInt(token) <= 0xffffffffffffffffn }

// Callers provide PF explicitly so offline fixtures never invoke the host's PF.
// The existing wildcard entry is required: never load/flush the main ruleset.
export async function enableTicketTransport(anchor: string, ruleFile: string, pf: TicketPf, save: SaveTicketTransport) {
  if (!validTransportAnchor(anchor)) fail('ticket_transport_anchor_invalid')
  const mainRules = (await pf(['-s', 'rules'])).stdout
  if (!/^anchor "com\.apple\/\*"(?: all)?\s*$/m.test(mainRules)) fail('ticket_transport_existing_anchor_entry_required')
  if ((await pf(['-a', anchor, '-s', 'rules'])).stdout.trim()) fail('ticket_transport_anchor_not_empty')
  const state: TicketTransportState = { anchor, ruleFile, mainRules }
  await save(state) // Ownership precedes mutation, including a partially failed load.
  try {
    await pf(['-a', anchor, '-f', ruleFile])
    const loaded = (await pf(['-a', anchor, '-s', 'rules'])).stdout.trim()
    if (!/^block return out quick proto udp from any to any port (?:= )?443 label "miaoimg-staple"$/.test(loaded)) fail('ticket_transport_own_rule_not_verified')
    if ((await pf(['-s', 'rules'])).stdout !== mainRules) fail('ticket_transport_main_rules_changed')
    state.enableAttempted = true; await save(state)
    const enabled = await pf(['-E'])
    const tokens = [...(enabled.stdout + '\n' + enabled.stderr).matchAll(/^\s*Token\s*:\s*(\d{1,20})\s*$/gm)].map(match => match[1])
    if (tokens.length !== 1 || !validTransportToken(tokens[0])) fail('ticket_transport_enable_token_unavailable')
    state.token = tokens[0]; await save(state)
    if (!/^Status:\s+Enabled\b/m.test((await pf(['-s', 'info'])).stdout)) fail('ticket_transport_pf_not_enabled')
    if ((await pf(['-s', 'rules'])).stdout !== mainRules) fail('ticket_transport_main_rules_changed')
    return state
  } catch (error) {
    // The in-memory lease can still release its token if persistence failed.
    await disableTicketTransport(state, pf, save).catch(() => {})
    throw error
  }
}

export async function disableTicketTransport(state: TicketTransportState, pf: TicketPf, save: SaveTicketTransport) {
  if (!validTransportAnchor(state.anchor) || state.token && !validTransportToken(state.token)) fail('ticket_transport_cleanup_state_invalid')
  let problem: unknown, blockedPackets: number | undefined
  try {
    const fields = (await pf(['-a', state.anchor, '-s', 'labels'])).stdout.trim().split(/\s+/)
    if (fields[0] === 'miaoimg-staple' && /^\d+$/.test(fields[2] || '') && Number.isSafeInteger(Number(fields[2]))) blockedPackets = Number(fields[2])
  } catch { /* Counters are optional; never obstruct release of owned resources. */ }
  if (!state.anchorCleared) try {
    await pf(['-a', state.anchor, '-F', 'rules'])
    if ((await pf(['-a', state.anchor, '-s', 'rules'])).stdout.trim()) fail('ticket_transport_anchor_not_cleared')
    state.anchorCleared = true; await save(state)
  } catch (error) { problem = error }
  if (state.token && !state.tokenReleased) try {
    await pf(['-X', state.token]); state.tokenReleased = true; await save(state)
  } catch (error) { problem ||= error }
  if (state.enableAttempted && !state.token) problem ||= new SigningFailure('ticket_transport_own_enable_token_unknown')
  try { if ((await pf(['-s', 'rules'])).stdout !== state.mainRules) fail('ticket_transport_main_rules_changed') } catch (error) { problem ||= error }
  if (problem) throw problem
  return { anchorCleared: true, ownEnableReferenceReleased: !state.enableAttempted || state.tokenReleased === true, ...(blockedPackets === undefined ? {} : { blockedUdp443Packets: blockedPackets }), mainRulesUnchanged: true }
}

function assertHostedTransport() {
  if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted') fail('ticket_transport_github_hosted_runner_required')
}
const ticketPf: TicketPf = args => command('/usr/bin/sudo', ['-n', '/sbin/pfctl', ...args], args[0] === '-E' ? 'ticket_transport_enable' : args[0] === '-X' ? 'ticket_transport_release_reference' : args.includes('-f') ? 'ticket_transport_load_own_anchor' : args.includes('-F') ? 'ticket_transport_clear_own_anchor' : 'ticket_transport_inspect', { timeout: 15_000 })
async function saveTicketTransport(state: TicketTransportState) {
  const path = paths().networkState
  await writeFile(path + '.next', JSON.stringify(state), { mode: 0o600 })
  await rename(path + '.next', path)
}

async function prepareTicketTransport() {
  assertHostedTransport()
  const path = paths()
  if (await exists(path.networkState) || await exists(path.networkState + '.next') || await exists(path.networkRule)) fail('ticket_transport_must_start_empty')
  await writeFile(path.networkRule, ticketTransportRule, { mode: 0o600, flag: 'wx' })
  const anchor = `com.apple/miaoimg-staple-${required('GITHUB_RUN_ID')}-${required('GITHUB_RUN_ATTEMPT')}-${randomBytes(4).toString('hex')}`
  await enableTicketTransport(anchor, path.networkRule, ticketPf, saveTicketTransport)
  await record({ stage: 'transport-prepare', scope: 'github-hosted-job-only', existingWildcardAnchor: true, ownRuleVerified: true, pfEnabled: true, mainRulesUnchanged: true, http3CauseConfirmed: false })
}
async function cleanupTicketTransport() {
  assertHostedTransport()
  const path = paths()
  if (!await exists(path.networkState)) {
    await rm(path.networkState + '.next', { force: true })
    await rm(path.networkRule, { force: true })
    await record({ stage: 'transport-cleanup', notConfigured: true }); return
  }
  const state: TicketTransportState = JSON.parse(await readFile(path.networkState, 'utf8'))
  if (!state.anchor.startsWith(`com.apple/miaoimg-staple-${required('GITHUB_RUN_ID')}-${required('GITHUB_RUN_ATTEMPT')}-`) || state.ruleFile !== path.networkRule) fail('ticket_transport_cleanup_ownership_mismatch')
  const cleaned = await disableTicketTransport(state, ticketPf, saveTicketTransport)
  await rm(path.networkRule, { force: true }); await rm(path.networkState); await rm(path.networkState + '.next', { force: true })
  await record({ stage: 'transport-cleanup', ...cleaned })
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

export function classifyDependencySigningError(error: unknown) {
  const value = error as { message?: unknown; cmd?: unknown; stderr?: unknown; code?: unknown; signal?: unknown }
  const raw = typeof value?.message === 'string' ? value.message : ''
  const commandLine = typeof value?.cmd === 'string' ? value.cmd : raw.startsWith('Command failed: ') ? raw.split('\n', 1)[0].slice(16) : ''
  // The command is inspected only for a fixed tool/operation. Do not classify
  // credential or path text in its arguments as a diagnostic cause.
  const body = (raw.startsWith('Command failed: ') ? raw.includes('\n') ? raw.slice(raw.indexOf('\n') + 1) : '' : raw)
    + (typeof value?.stderr === 'string' ? '\n' + value.stderr : '')
  const isCodesign = /^(?:\/usr\/bin\/)?codesign(?:\s|$)/.test(commandLine)
  let toolCode: keyof typeof signingMessages | undefined, operation: string | undefined
  let exitCode = typeof value?.code === 'number' && Number.isInteger(value.code) && value.code >= 0 && value.code <= 255 ? value.code : undefined
  if (/^Failed to staple your application with code:/.test(body)) {
    toolCode = 'notary_staple_failed'; operation = 'staple'
  } else if (/^Failed to zip application, exited with code:/.test(body)) { toolCode = 'notary_archive_failed'; operation = 'archive' }
  else if (/^Failed to notarize via notarytool/.test(body)) { toolCode = 'notary_submit_failed'; operation = 'notary-submit' }
  else if (/^notarytool is not available/.test(body)) { toolCode = 'notary_tool_unavailable'; operation = 'notary-submit' }
  else if (/^Failed to (?:display codesign info on|codesign) your application with code:/.test(body)) { toolCode = 'notary_signature_preflight_failed'; operation = 'notary-signature-check' }
  else if (isCodesign) {
    operation = /(?:^|\s)--sign(?:=|\s)|(?:^|\s)-s(?:\s|$)/.test(commandLine) ? 'sign'
      : /(?:^|\s)--verify(?:\s|$)|(?:^|\s)-v{1,4}(?:\s|$)/.test(commandLine) ? 'verify' : 'display'
    toolCode = /User interaction is not allowed|CSSMERR_CSP_NO_USER_INTERACTION|errSecInteractionNotAllowed/i.test(body) ? 'codesign_keychain_interaction_denied'
      : /errSecInternalComponent/.test(body) ? 'codesign_keychain_internal_error'
        : /specified item could not be found in the keychain|CSSMERR_TP_NOT_TRUSTED|unable to build chain to self-signed root/i.test(body) ? 'codesign_identity_or_chain_unavailable'
          : /timestamp (?:service|server)|unable to obtain (?:a )?timestamp|timestamp.*(?:not available|unavailable)|timestamp request.*failed/i.test(body) ? 'codesign_timestamp_unavailable'
            : /resource fork, Finder information|similar detritus not allowed/i.test(body) ? 'codesign_extended_attributes_rejected'
              : /invalid.*entitlements|entitlements.*(?:invalid|not permitted|malformed)/i.test(body) ? 'codesign_entitlements_invalid'
                : /bundle format.*(?:unrecognized|invalid)|not a bundle/i.test(body) ? 'codesign_bundle_format_invalid'
                  : /not signed at all|code object is not signed|sealed resource.*(?:missing|invalid)|unsealed contents|code or signature.*modified|invalid signature/i.test(body) ? 'codesign_signature_invalid'
                    : 'codesign_command_failed'
  }
  if (!toolCode) return undefined
  if (exitCode === undefined) {
    const code = Number(/^Failed to (?:staple your application with code:|zip application, exited with code:|(?:display codesign info on|codesign) your application with code:)\s*(\d{1,3})(?=\s|$)/.exec(body)?.[1])
    if (Number.isInteger(code) && code >= 0 && code <= 255) exitCode = code
  }
  const signal = typeof value?.signal === 'string' && ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGINT'].includes(value.signal) ? value.signal : undefined
  const status = toolCode === 'notary_submit_failed' ? /"status"\s*:\s*"(Accepted|Invalid|Rejected|In Progress)"/.exec(body)?.[1] : undefined
  const networkCode = toolCode === 'notary_staple_failed' ? /Error Domain=NSURLErrorDomain Code=(-1001|-1003|-1005|-1009|-1200|-1202)(?=\D|$)/.exec(body)?.[1] : undefined
  const ticketFailure = toolCode === 'notary_staple_failed' ? networkCode ? 'network_error'
    : /Record not found/.test(body) ? 'ticket_record_not_found'
      : /CloudKit.s response is inconsistent/.test(body) ? 'unexpected_ticket_service_response' : undefined : undefined
  return { toolCode, operation, ...(exitCode === undefined ? {} : { exitCode }), ...(signal ? { signal } : {}), ...(status ? { notaryStatus: status } : {}), ...(networkCode ? { networkCode: Number(networkCode) } : {}), ...(ticketFailure ? { ticketFailure } : {}), message: signingMessages[toolCode] }
}

export function safeSigningDiagnostic(error: unknown) {
  const value = error as { name?: unknown; code?: unknown; message?: unknown; errors?: unknown }
  const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AggregateError', 'ValidationError', 'InvalidConfigurationError', 'SigningFailure', 'ExecError', 'TimeoutError', 'AbortError'])
  const codes = new Set(['ERR_ELECTRON_BUILDER_INVALID_CONFIGURATION', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_REQUIRE_ESM', 'ERR_REQUIRE_ASYNC_MODULE', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_UNKNOWN_FILE_EXTENSION', 'ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ENOSPC', 'ETIMEDOUT', 'ECONNRESET', 'ENOEXEC', 'ENOTFOUND'])
  const type = typeof value?.name === 'string' && names.has(value.name) ? value.name : 'Error'
  const dependency = error instanceof SigningFailure ? undefined : classifyDependencySigningError(error)
  const code = error instanceof SigningFailure ? error.code : typeof value?.code === 'string' && codes.has(value.code) ? value.code : dependency?.toolCode
  const raw = typeof value?.message === 'string' ? value.message : ''
  // Never copy a raw message, argv, schema data/params, cause or stack. These
  // exact schema paths and constant messages are safe even for tool failures.
  const knownPaths = ['mac', 'mac.identity', 'mac.sign', 'mac.notarize', 'mac.type', 'mac.hardenedRuntime', 'mac.entitlements', 'mac.entitlementsInherit', 'dmg', 'dmg.sign', 'forceCodeSigning', 'afterPack', 'afterSign', 'directories', 'directories.app', 'directories.output', 'files', 'publish', 'appId', 'productName', 'electronVersion', 'extraMetadata', 'asar']
  const schemaPaths = new Set<string>()
  let message = 'Unclassified packaging failure; raw tool output omitted'
  if (error instanceof SigningFailure) message = error.tool ? extractMessages[error.tool.toolCode] : 'Controlled release verification failed'
  else if (dependency) message = dependency.message
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
  return { type, ...(code ? { code } : {}), ...(schemaPaths.size ? { schemaPaths: [...schemaPaths] } : {}), ...(dependency || {}), ...(error instanceof SigningFailure && error.tool ? error.tool : {}), message }
}

export async function observedAppSigning(architecture: string, app: string, sign: () => Promise<void>, emit: (check: Record<string, unknown>) => Promise<void> = record) {
  const candidate = resolve(app)
  buildApplications.set(architecture, { app: candidate, boundary: 'signAsync' })
  await emit({ stage: 'build', checkpoint: 'signAsync-start', architecture, at: new Date().toISOString() })
  try { await sign() }
  catch (error) {
    await emit({ stage: 'build', checkpoint: 'signAsync-failed', architecture, at: new Date().toISOString(), diagnostic: safeSigningDiagnostic(error) }).catch(() => {})
    throw error
  }
  buildApplications.set(architecture, { app: candidate, boundary: 'builder-notarization' })
  await emit({ stage: 'build', checkpoint: 'signAsync-complete-await-builder-notarization', architecture, at: new Date().toISOString() })
}

export async function readOnlySignatureState(app: string, team: string, inspect = command) {
  const safePath = resolve(app).startsWith(join(desktop, 'release') + sep) && app.endsWith('.app')
  if (!safePath) return { inspected: false, reason: 'outside_candidate_app_directory' }
  let signatureVerified = false, details = ''
  try { await inspect('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], 'failure_readonly_signature', { timeout: 30_000 }); signatureVerified = true } catch { /* status only */ }
  try { const result = await inspect('/usr/bin/codesign', ['--display', '--verbose=4', app], 'failure_readonly_signature_details', { timeout: 15_000 }); details = result.stdout + result.stderr } catch { /* status only */ }
  return { inspected: true, signatureVerified, detailsAvailable: Boolean(details), developerIdAuthority: /^Authority=Developer ID Application:/m.test(details), expectedTeam: Boolean(team) && /^TeamIdentifier=(\S+)$/m.exec(details)?.[1] === team, hardenedRuntime: /flags=.*\(.*runtime.*\)/.test(details), timestamp: /^Timestamp=\S/m.test(details) }
}

async function recordFailedBuildState() {
  const state = await readState()
  for (const [architecture, context] of buildApplications) if (context.boundary !== 'verified') {
    const signature = await readOnlySignatureState(context.app, state.team || '')
    await record({ stage: 'build', checkpoint: 'failure-readonly-signature-state', architecture, boundary: context.boundary, ...signature })
  }
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
    async options => {
      if (options.keychain !== state.keychain || options.identity !== state.sha1) fail('builder_signing_identity_changed')
      const architecture = architectures.find(arch => basename(dirname(options.app)) === arch.directory)?.binary || 'unknown'
      await observedAppSigning(architecture, options.app, () => signAsync({ ...options, identity: state.sha1, keychain: state.keychain, identityValidation: false }))
    },
    async context => {
      const architecture = context.arch === Arch.arm64 ? 'arm64' : context.arch === Arch.x64 ? 'x86_64' : fail('unexpected_packaging_architecture')
      const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      buildApplications.set(architecture, { app, boundary: 'afterSign' })
      await record({ stage: 'build', checkpoint: 'afterSign-entered-builder-notarization-returned', architecture, at: new Date().toISOString() })
      await verifyApplication(app, architecture, `before-archive-${architecture}`)
      buildApplications.set(architecture, { app, boundary: 'verified' })
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
    if (action === 'transport-prepare') await prepareTicketTransport()
    else if (action === 'transport-cleanup') await cleanupTicketTransport()
    else if (action === 'preflight') await preflight()
    else if (action === 'prepare') await prepare()
    else if (action === 'build') await build()
    else if (action === 'verify-build') await verifyBuild()
    else if (action === 'finalize') await finalize()
    else if (action === 'cleanup') await cleanup()
    else if (action === 'proof') await sanitizedProof()
    else fail('unknown_signing_stage')
    if (action !== 'proof') { const value = await proof(); value.stages.push(action); await mkdir(paths().proofDirectory, { recursive: true }); await writeFile(paths().proof, JSON.stringify(value, null, 2) + '\n') }
  } catch (error) {
    if (action === 'build') await recordFailedBuildState().catch(() => {})
    const diagnostic = safeSigningDiagnostic(error)
    const value = preserveFirstSigningFailure(await proof(), { stage, code: diagnostic.code || 'signing_or_packaging_failed', diagnostic })
    await mkdir(paths().proofDirectory, { recursive: true }); await writeFile(paths().proof, JSON.stringify(value, null, 2) + '\n')
    // Do not print child-process arguments, Apple account errors or secret values.
    console.error(`macOS release stage failed: ${JSON.stringify(value.failure)}`); process.exitCode = 1
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main(process.argv[2] || '')
