import { cp, lstat, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDesktopResourcePath } from './desktop-resources.ts'
import { THIRD_PARTY_NOTICES } from './third-party-notices.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const requireBuild = createRequire(join(root, 'desktop/renderer/package.json'))
const { transform } = requireBuild('esbuild') as typeof import('../desktop/renderer/node_modules/esbuild/lib/main.js')

// Electron loads compiled JavaScript; Node services and maintenance commands
// run the TypeScript sources directly on the supported Node version.
export async function compileDesktop() {
  const output = resolve(root, 'desktop/.app')
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  const resourceFilter = async (input: string) => isDesktopResourcePath(relative(root, input)) && !(await lstat(input)).isSymbolicLink()
  const copyResources = (input: string, target: string) => cp(input, target, { recursive: true, filter: resourceFilter })
  async function compileTree(source: string, destination: string) {
    await mkdir(destination, { recursive: true })
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (source === join(root, 'desktop') && entry.name === 'renderer') continue
      const input = join(source, entry.name), target = join(destination, entry.name)
      if (!isDesktopResourcePath(relative(root, input)) || entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        // Skill references are data, including .ts examples linked by name.
        // Preserve resource filenames while applying the same credential/state filter.
        if (source === join(root, 'server') && ['builtin-skills', 'builtin-teams', 'locales'].includes(entry.name)) await copyResources(input, target)
        else await compileTree(input, target)
      }
      else if (extname(entry.name) === '.ts') {
        const preload = entry.name === 'preload.ts'
        const result = await transform(await readFile(input, 'utf8'), { loader: 'ts', target: 'node22', format: preload ? 'cjs' : 'esm', sourcefile: input })
        const code = result.code.replace(/(\bfrom\s*["']|\bimport\s*\(\s*["'])(\.{1,2}\/[^"']+)\.ts(["'])/g, '$1$2.js$3')
        await writeFile(target.replace(/\.ts$/, preload ? '.cjs' : '.js'), code)
      } else await copyResources(input, target)
    }
  }
  await compileTree(join(root, 'server'), join(output, 'server'))
  await compileTree(join(root, 'desktop'), join(output, 'desktop'))
  await copyResources(join(root, 'docs/compatibility'), join(output, 'docs/compatibility'))
  await mkdir(join(output, 'docs/licenses'), { recursive: true })
  await writeFile(join(output, 'docs/licenses/THIRD_PARTY_NOTICES.txt'), THIRD_PARTY_NOTICES)
  await copyResources(join(root, 'LICENSE'), join(output, 'docs/licenses/LICENSE.txt'))
  await copyResources(join(root, 'desktop/renderer/dist'), join(output, 'web'))
  await writeFile(join(output, 'version.json'), JSON.stringify({ desktop: JSON.parse(await readFile(join(root, 'desktop/package.json'), 'utf8')).version, web: JSON.parse(await readFile(join(root, 'desktop/renderer/package.json'), 'utf8')).version }))
  return output
}
