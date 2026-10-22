import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { NtExecutable, NtExecutableResource, Data, Resource } from 'resedit'

export default async function windowsResources(context) {
  const info = context.packager.appInfo
  const updateResources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, info.productFilename + '.app', 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  await mkdir(updateResources, { recursive: true })
  await writeFile(join(updateResources, 'app-update.yml'), 'provider: generic\nurl: https://miaoimg.cn/desktop-downloads/updates/\n')
  if (context.electronPlatformName !== 'win32') return
  const path = join(context.appOutDir, info.productFilename + '.exe')
  const exe = NtExecutable.from(await readFile(path), { ignoreCert: true })
  const resources = NtExecutableResource.from(exe)
  const icons = Data.IconFile.from(await readFile(new URL('../assets/icon.ico', import.meta.url)))
  for (const group of Resource.IconGroupEntry.fromEntries(resources.entries)) Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons.icons.map(icon => icon.data))
  const version = Resource.VersionInfo.fromEntries(resources.entries)[0]
  if (!version) throw new Error('Windows 版本资源缺失')
  for (const language of version.getAllLanguagesForStringValues()) {
    version.setFileVersion(info.version, language.lang)
    version.setProductVersion(info.version, language.lang)
    version.setStringValues(language, { CompanyName: 'MiaoImg', FileDescription: '妙图', ProductName: '妙图', InternalName: 'MiaoImgDesktop', OriginalFilename: info.productFilename + '.exe', LegalCopyright: 'Copyright © 2026 MiaoImg' })
  }
  version.outputToResourceEntries(resources.entries)
  resources.outputResource(exe)
  const temp = path + '.resources'
  await writeFile(temp, Buffer.from(exe.generate()))
  await rename(temp, path)
}
