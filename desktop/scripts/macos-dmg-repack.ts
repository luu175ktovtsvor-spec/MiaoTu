// CI-only DMG surgery: preserve the signed App and all original ZIP bytes.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

type InputAsset = { name: string; url: string; size: number; sha256: string }
type InputManifest = { version: string; productName: string; assets: InputAsset[] }
type Context = {
  privateDirectory: string; outputDirectory: string; repositoryDirectory: string; commit: string; publicPrefix: string; metadata: any
  command: (file: string, args: string[], label: string, options?: any) => Promise<{ stdout: string; stderr: string }>
  record: (value: Record<string, unknown>) => Promise<void>; proof: () => Promise<any>; readState: () => Promise<any>
  verifyApplication: (app: string, architecture: string, label: string) => Promise<void>
  verifyDmg: (file: string, architecture: string, inspectAfter?: (mount: string) => Promise<Record<string, unknown>>) => Promise<void>
  inspectDmgContents: (mount: string, productName: string, legacy?: boolean) => Promise<any>
  loadTools: () => { yaml: any; buildBlockMap: (file: string, format: string, output: string) => Promise<{ sha512: string; size: number }> }
}
const architectures = [{ name: 'arm64', binary: 'arm64' }, { name: 'x64', binary: 'x86_64' }]
const legacyHelper = '首次使用，请右键打开.command'
export class RepackFailure extends Error { code: string; constructor(code: string) { super('Controlled DMG repack verification failed'); this.name = 'RepackFailure'; this.code = code } }
const fail = (code: string): never => { throw new RepackFailure(code) }
const exists = path => access(path).then(() => true, () => false)
export async function fileDigest(file: string, algorithm = 'sha256', encoding: 'hex' | 'base64' = 'hex') { const hash = createHash(algorithm); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest(encoding) }
async function saveJson(file, value) { await writeFile(file + '.next', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(file + '.next', file) }

export function validateRepackManifest(raw: string, expected: { version: string; productName: string }): InputManifest {
  if (!raw || raw.length > 20000) fail('repack_manifest_size_invalid')
  let value: InputManifest; try { value = JSON.parse(raw) } catch { fail('repack_manifest_invalid_json') }
  if (!value || value.version !== expected.version || value.productName !== expected.productName || !/^\d+\.\d+\.\d+$/.test(value.version) || !Array.isArray(value.assets) || value.assets.length !== 7) fail('repack_manifest_scope_mismatch')
  const names = new Set(['latest-mac.yml', ...architectures.flatMap(arch => ['dmg', 'zip', 'zip.blockmap'].map(ext => `${value.productName}-${value.version}-${arch.name}.${ext}`))])
  for (const asset of value.assets) {
    if (!asset || !names.delete(asset.name) || !/^[a-f\d]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > (asset.name.endsWith('.dmg') || asset.name.endsWith('.zip') ? 3 * 1024 ** 3 : 4 * 1024 ** 2)) fail('repack_input_asset_invalid')
    let url: URL; try { url = new URL(asset.url) } catch { fail('repack_input_url_invalid') }
    if (url.origin !== 'https://miaoimg.cn' || url.username || url.password || url.search || url.hash || decodeURIComponent(url.pathname) !== '/desktop-downloads/updates/' + asset.name) fail('repack_input_url_not_fixed_public_asset')
  }
  if (names.size) fail('repack_input_assets_missing')
  return value
}

// Canonical metadata excludes access/change times, which reads/mounts may alter.
// Bytes, relative paths, types, permissions, ownership, mtime, flags and every
// readable extended attribute (including resource forks/tickets) are preserved.
export const appTreeProgram = String.raw`
import os,sys,stat,json,hashlib,errno,ctypes
root=sys.argv[1]; rows=[]; files=0; total=0
lib=ctypes.CDLL(None,use_errno=True)
XATTR_OPTIONS=0x0001|0x0020 # NOFOLLOW and SHOWCOMPRESSION from Darwin sys/xattr.h
lib.listxattr.argtypes=[ctypes.c_char_p,ctypes.c_void_p,ctypes.c_size_t,ctypes.c_int]
lib.listxattr.restype=ctypes.c_ssize_t
lib.getxattr.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_void_p,ctypes.c_size_t,ctypes.c_uint32,ctypes.c_int]
lib.getxattr.restype=ctypes.c_ssize_t
def attributes(path):
 encoded=os.fsencode(path); count=lib.listxattr(encoded,None,0,XATTR_OPTIONS)
 if count<0:
  error=ctypes.get_errno()
  if error in (errno.ENOTSUP,errno.EOPNOTSUPP): return {}
  raise OSError(error,'listxattr failed')
 names=ctypes.create_string_buffer(count)
 used=lib.listxattr(encoded,names,count,XATTR_OPTIONS)
 if used<0: raise OSError(ctypes.get_errno(),'listxattr failed')
 result={}
 for key in sorted(name for name in names.raw[:used].split(b'\0') if name):
  length=lib.getxattr(encoded,key,None,0,0,XATTR_OPTIONS)
  if length<0: raise OSError(ctypes.get_errno(),'getxattr failed')
  data=ctypes.create_string_buffer(length)
  actual=lib.getxattr(encoded,key,data,length,0,XATTR_OPTIONS)
  if actual<0: raise OSError(ctypes.get_errno(),'getxattr failed')
  result[os.fsdecode(key)]=hashlib.sha256(data.raw[:actual]).hexdigest()
 return result
def walk(path,relative):
 global files,total
 s=os.lstat(path); attrs=attributes(path)
 row=[relative,stat.S_IFMT(s.st_mode),stat.S_IMODE(s.st_mode),s.st_uid,s.st_gid,s.st_mtime_ns,getattr(s,'st_flags',0),attrs]
 if stat.S_ISREG(s.st_mode):
  digest=hashlib.sha256()
  with open(path,'rb') as stream:
   for chunk in iter(lambda:stream.read(1024*1024),b''): digest.update(chunk)
  row += [s.st_size,digest.hexdigest()];files+=1;total+=s.st_size
 elif stat.S_ISLNK(s.st_mode): row += [os.readlink(path)]
 elif not stat.S_ISDIR(s.st_mode): raise ValueError('unsupported App filesystem entry')
 rows.append(row)
 if stat.S_ISDIR(s.st_mode):
  for name in sorted(os.listdir(path)): walk(os.path.join(path,name),relative+'/'+name)
walk(root,'.')
payload=json.dumps(rows,ensure_ascii=True,separators=(',',':')).encode()
print(json.dumps({'sha256':hashlib.sha256(payload).hexdigest(),'entries':len(rows),'files':files,'bytes':total}))
`
export async function appTree(ctx: Context, app: string) {
  const output = await ctx.command('python3', ['-c', appTreeProgram, app], 'repack_read_app_tree')
  let value; try { value = JSON.parse(output.stdout) } catch { fail('repack_app_tree_response_invalid') }
  if (!/^[a-f\d]{64}$/.test(value?.sha256) || !Number.isInteger(value.files) || value.files < 1 || !Number.isInteger(value.entries) || value.entries <= value.files) fail('repack_app_tree_invalid')
  return value
}

async function registerMount(ctx: Context, mount: string) {
  const file = join(ctx.privateDirectory, 'repack-mounts.json'), mounts = await exists(file) ? JSON.parse(await readFile(file, 'utf8')) : []
  if (!mounts.includes(mount)) mounts.push(mount)
  await saveJson(file, mounts)
}
async function withMount<T>(ctx: Context, image: string, mount: string, writable: boolean, work: (mount: string) => Promise<T>) {
  await mkdir(mount); await registerMount(ctx, mount)
  let attached = false
  try {
    await ctx.command('/usr/bin/hdiutil', ['attach', writable ? '-readwrite' : '-readonly', '-nobrowse', '-noautoopen', '-owners', 'on', '-mountpoint', mount, image], 'repack_attach_image'); attached = true
    return await work(mount)
  } finally { if (attached) await ctx.command('/usr/bin/hdiutil', ['detach', mount], 'repack_detach_image') }
}
export async function cleanupRepackMounts(ctx: Context) {
  const file = join(ctx.privateDirectory, 'repack-mounts.json')
  if (!await exists(file)) return
  const mounts = JSON.parse(await readFile(file, 'utf8'))
  if (!Array.isArray(mounts) || mounts.some(mount => typeof mount !== 'string' || !resolve(mount).startsWith(resolve(ctx.privateDirectory) + sep) || !/^repack-(?:source|rw)-(?:arm64|x64)$/.test(basename(mount)))) fail('repack_cleanup_mount_scope_invalid')
  for (const mount of mounts) {
    const info = await ctx.command('/usr/bin/hdiutil', ['info', '-plist'], 'repack_inspect_cleanup_mounts')
    if (info.stdout.includes('<string>' + mount + '</string>')) await ctx.command('/usr/bin/hdiutil', ['detach', mount], 'repack_cleanup_owned_mount').catch(() => ctx.command('/usr/bin/hdiutil', ['detach', '-force', mount], 'repack_force_cleanup_owned_mount'))
  }
}

async function downloadAsset(asset: InputAsset, directory: string) {
  const file = join(directory, asset.name)
  const response = await fetch(asset.url, { redirect: 'error', signal: AbortSignal.timeout(240000) })
  if (!response.ok || !response.body) fail('repack_input_download_failed')
  let size = 0
  const hash = createHash('sha256')
  const { Transform } = await import('node:stream')
  const meter = new Transform({ transform(chunk, _encoding, done) { size += chunk.length; hash.update(chunk); done(size > asset.size ? new Error('repack_input_size_exceeded') : null, chunk) } })
  await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(file, { mode: 0o600, flags: 'wx' }))
  if (size !== asset.size || hash.digest('hex') !== asset.sha256) fail('repack_input_hash_or_size_mismatch')
}

export function validateRepackMetadata(metadata: any, manifest: InputManifest) {
  const expected = manifest.assets.filter(asset => /\.(?:zip|dmg)$/.test(asset.name)).map(asset => asset.name), seen = new Set<string>()
  if (metadata?.version !== manifest.version || !Array.isArray(metadata.files) || metadata.files.length !== 4 || !expected.includes(metadata.path) || !metadata.path.endsWith('.zip')) fail('repack_metadata_scope_invalid')
  for (const entry of metadata.files) {
    if (!expected.includes(entry.url) || seen.has(entry.url) || !/^[A-Za-z0-9+/]{86}==$/.test(entry.sha512 || '') || !Number.isSafeInteger(entry.size) || entry.size <= 0) fail('repack_metadata_entry_invalid')
    seen.add(entry.url)
  }
  if (metadata.sha512 !== metadata.files.find(entry => entry.url === metadata.path)?.sha512) fail('repack_metadata_primary_zip_mismatch')
}

export async function repackDmgs(ctx: Context) {
  const raw = process.env.MIAO_DMG_REPACK_MANIFEST || '', manifest = validateRepackManifest(raw, ctx.metadata)
  const source = join(ctx.privateDirectory, 'repack-source'), output = ctx.outputDirectory, publish = join(output, 'publish')
  if (await exists(source) || await exists(output)) fail('repack_workspace_must_start_empty')
  await mkdir(source); await mkdir(output, { mode: 0o700 }); await mkdir(publish)
  await ctx.record({ stage: 'repack', inputManifestSha256: createHash('sha256').update(raw).digest('hex'), sourceVersion: manifest.version, inputCount: manifest.assets.length, sourceDownloadsFixedByHash: true })
  for (const asset of manifest.assets) await downloadAsset(asset, source)
  const { yaml, buildBlockMap } = ctx.loadTools(), original = yaml.load(await readFile(join(source, 'latest-mac.yml'), 'utf8'))
  validateRepackMetadata(original, manifest)
  for (const entry of original.files) if (await fileDigest(join(source, entry.url), 'sha512', 'base64') !== entry.sha512 || (await lstat(join(source, entry.url))).size !== entry.size) fail('repack_original_metadata_hash_mismatch')
  const metadata = structuredClone(original)
  for (const arch of architectures) {
    const name = `${manifest.productName}-${manifest.version}-${arch.name}.dmg`, input = join(source, name), result = join(output, name), appName = `${manifest.productName}.app`
    await ctx.command('/usr/bin/codesign', ['--verify', '--strict', input], 'repack_original_dmg_signature')
    await ctx.command('/usr/bin/xcrun', ['stapler', 'validate', '-v', input], 'repack_original_dmg_staple')
    const before = await withMount(ctx, input, join(ctx.privateDirectory, `repack-source-${arch.name}`), false, async mount => {
      await ctx.inspectDmgContents(mount, manifest.productName, true)
      await ctx.verifyApplication(join(mount, appName), arch.binary, `repack-source-${arch.name}`)
      return appTree(ctx, join(mount, appName))
    })
    const writable = join(ctx.privateDirectory, `repack-${arch.name}-rw.dmg`)
    await ctx.command('/usr/bin/hdiutil', ['convert', input, '-format', 'UDRW', '-o', writable], 'repack_convert_writable')
    await withMount(ctx, writable, join(ctx.privateDirectory, `repack-rw-${arch.name}`), true, async mount => {
      await ctx.inspectDmgContents(mount, manifest.productName, true)
      if ((await appTree(ctx, join(mount, appName))).sha256 !== before.sha256) fail('repack_app_changed_during_conversion')
      await rm(join(mount, legacyHelper)) // Exactly the reviewed top-level regular file.
      await ctx.inspectDmgContents(mount, manifest.productName)
      if ((await appTree(ctx, join(mount, appName))).sha256 !== before.sha256) fail('repack_app_changed_while_removing_helper')
    })
    await ctx.command('/usr/bin/hdiutil', ['convert', writable, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-o', result], 'repack_convert_compressed')
    await ctx.verifyDmg(result, arch.binary, async mount => {
      const after = await appTree(ctx, join(mount, appName))
      if (after.sha256 !== before.sha256) fail('repack_final_app_tree_changed')
      return { repackOriginalAppUnchanged: true, appTreeSha256: before.sha256, appTreeEntries: before.entries, sourceDmgSha256: manifest.assets.find(asset => asset.name === name)!.sha256 }
    })
    const blockmap = await buildBlockMap(result, 'gzip', result + '.blockmap'), entry = metadata.files.find(file => file.url === name)
    entry.sha512 = blockmap.sha512; entry.size = blockmap.size; delete entry.blockMapSize
    await ctx.record({ stage: 'repack', architecture: arch.binary, completedArchitecture: true, appTreeSha256: before.sha256, originalAppUnchanged: true, noCommandEntries: true, dmgSignedNotarizedStapled: true, blockmapRebuiltFromFinalDmg: true })
  }
  for (const asset of manifest.assets) if (await fileDigest(join(source, asset.name)) !== asset.sha256) fail('repack_original_input_bytes_changed')
  for (const entry of metadata.files.filter(file => file.url.endsWith('.zip'))) if (JSON.stringify(entry) !== JSON.stringify(original.files.find(file => file.url === entry.url))) fail('repack_zip_metadata_changed')
  if (metadata.path !== original.path || metadata.sha512 !== original.sha512 || metadata.version !== original.version) fail('repack_primary_zip_or_version_changed')
  const publicName = (name: string) => name.replace(manifest.productName + '-', ctx.publicPrefix + '-')
  for (const arch of architectures) for (const extension of ['dmg', 'dmg.blockmap', 'zip', 'zip.blockmap']) {
    const name = `${manifest.productName}-${manifest.version}-${arch.name}.${extension}`
    await copyFile(join(extension.startsWith('dmg') ? output : source, name), join(publish, publicName(name)))
  }
  metadata.files = metadata.files.map(entry => ({ ...entry, url: publicName(entry.url) })); metadata.path = publicName(metadata.path)
  await writeFile(join(publish, 'latest-mac.yml'), yaml.dump(metadata, { lineWidth: -1, noRefs: true }))
  await ctx.command('python3', [join(ctx.repositoryDirectory, 'deploy/verify-update-metadata.py'), manifest.version, 'latest-mac.yml'], 'repack_verify_final_update_metadata', { cwd: publish })
  const artifacts = []
  for (const name of (await readdir(publish)).sort()) artifacts.push({ name, size: (await lstat(join(publish, name))).size, sha256: await fileDigest(join(publish, name)) })
  if (artifacts.length !== 9) fail('repack_publish_asset_count_invalid')
  await ctx.record({ stage: 'repack', repackCompleted: true, version: manifest.version, originalInputsUnchanged: true, zipAndZipBlockmapBytesUnchanged: true, windowsTouched: false, originalVersionUnchanged: true, updatedMetadataVerified: true, artifacts })
  const receipt = await ctx.proof(); receipt.complete = true; await saveJson(join(ctx.outputDirectory, 'receipt.json'), receipt)
}

export function assertRepackReceipt(value: any, commit: string, requireCleanup = false) {
  if (value?.operation !== 'dmg-repack' || value.commit !== commit || value.releaseSourceCommit !== commit || !/^[a-f\d]{40}$/.test(value.workflowDispatchCommit || '') || !/^[a-f\d]{40}$/.test(commit) || value.failure || !value.stages?.includes('repack') || !value.complete) fail('repack_independent_receipt_incomplete')
  const preflight = value.checks.find(check => check.stage === 'preflight' && check.issuer === 'Developer ID G2' && check.keychainNotImportedBeforeDependencies === true)
  if (!value.stages.includes('preflight') || !value.stages.includes('prepare') || !/^[A-F\d]{40}$/.test(preflight?.certificateSha1 || '') || !value.checks.some(check => check.stage === 'prepare' && check.certificateSha1 === preflight.certificateSha1 && check.isolatedSigningIdentityCount === 1 && check.appleCredentialsValidated === true)) fail('repack_signing_preparation_receipt_missing')
  for (const arch of architectures) {
    if (!value.checks.some(check => check.stage === 'repack' && check.completedArchitecture === true && check.architecture === arch.binary && check.originalAppUnchanged === true && check.noCommandEntries === true && check.dmgSignedNotarizedStapled === true && check.blockmapRebuiltFromFinalDmg === true && /^[a-f\d]{64}$/.test(check.appTreeSha256))) fail('repack_architecture_receipt_missing')
    if (!value.checks.some(check => check.architecture === arch.binary && check.dmgSignature === true && check.stapled === true && check.gatekeeper === 'accepted' && check.noCommandEntries === true && check.appDirectoryVerified === true && check.applicationsSymlink === '/Applications' && check.repackOriginalAppUnchanged === true)) fail('repack_final_mount_receipt_missing')
    for (const label of [`repack-source-${arch.name}`, `dmg-${arch.binary}`]) if (!value.checks.some(check => check.label === label && check.architecture === arch.binary && check.certificateSha1 === preflight.certificateSha1 && check.deepStrictSignature === true && check.hardenedRuntime === true && check.timestamp === true && check.stapled === true && check.gatekeeper === 'accepted' && check.credentialProtection === 'local-key')) fail('repack_app_signature_receipt_missing')
  }
  const completed = value.checks.find(check => check.repackCompleted === true && check.originalInputsUnchanged === true && check.zipAndZipBlockmapBytesUnchanged === true && check.windowsTouched === false && check.originalVersionUnchanged === true && check.updatedMetadataVerified === true)
  if (!completed || !Array.isArray(completed.artifacts) || completed.artifacts.length !== 9) fail('repack_complete_artifact_receipt_missing')
  if (requireCleanup && (value.cleanup !== true || !value.stages.includes('cleanup') || !value.checks.some(check => check.stage === 'transport-cleanup' && check.anchorCleared === true && check.ownEnableReferenceReleased === true))) fail('repack_cleanup_receipt_missing')
  return completed
}
export async function verifyRepack(ctx: Context, requireCleanup = false) {
  // This path intentionally never calls loadTools or imports electron-builder.
  const proof = await ctx.proof(), receipt = JSON.parse(await readFile(join(ctx.outputDirectory, 'receipt.json'), 'utf8'))
  const completed = assertRepackReceipt(proof, ctx.commit, requireCleanup)
  const raw = process.env.MIAO_DMG_REPACK_MANIFEST || '', manifest = validateRepackManifest(raw, ctx.metadata)
  if (!proof.checks.some(check => check.inputManifestSha256 === createHash('sha256').update(raw).digest('hex') && check.inputCount === 7)) fail('repack_input_manifest_receipt_mismatch')
  const expectedVisible = [manifest.productName + '.app', 'Applications'].sort()
  for (const arch of architectures) if (!proof.checks.some(check => check.architecture === arch.binary && check.dmgSignature === true && JSON.stringify(check.visibleEntries) === JSON.stringify(expectedVisible))) fail('repack_visible_mount_receipt_missing')
  if (receipt.operation !== 'dmg-repack' || receipt.commit !== proof.commit || receipt.failure || receipt.complete !== true || JSON.stringify(receipt.checks.find(check => check.repackCompleted === true)?.artifacts) !== JSON.stringify(completed.artifacts)) fail('repack_output_receipt_mismatch')
  const publish = join(ctx.outputDirectory, 'publish'), expected = completed.artifacts.map(file => file.name).sort()
  const expectedNames = ['latest-mac.yml', ...architectures.flatMap(arch => ['dmg', 'dmg.blockmap', 'zip', 'zip.blockmap'].map(ext => `${ctx.publicPrefix}-${manifest.version}-${arch.name}.${ext}`))].sort()
  if (JSON.stringify(expected) !== JSON.stringify(expectedNames)) fail('repack_publish_names_not_exact')
  if (JSON.stringify((await readdir(publish)).sort()) !== JSON.stringify(expected)) fail('repack_output_assets_not_exact')
  for (const artifact of completed.artifacts) if (basename(artifact.name) !== artifact.name || (await lstat(join(publish, artifact.name))).size !== artifact.size || await fileDigest(join(publish, artifact.name)) !== artifact.sha256) fail('repack_output_asset_hash_mismatch')
  await ctx.record({ stage: 'repack-verify', independentReceiptVerified: true, builderImported: false, publicationCleanupVerified: requireCleanup, artifactCount: 9 })
}
