import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

// Server artifacts only; this never builds or publishes a desktop installer.
// Compile for distribution Node builds that omit native TypeScript support.
const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const ts = require(join(root, 'desktop/renderer/node_modules/typescript'))
const { values } = parseArgs({ options: { output: { type: 'string' } } })
if (!values.output) throw new Error('--output is required')
const output = resolve(values.output)
const files = ['server/library-content-api.ts', 'server/showcase-schema.ts', 'scripts/build-showcase-content.ts', 'deploy/native/publish-library-content.ts']
for (const file of files) {
  const result = ts.transpileModule(await readFile(join(root, file), 'utf8'), {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true },
  })
  if (result.diagnostics?.some(x => x.category === ts.DiagnosticCategory.Error)) throw new Error('Content service compilation failed: ' + file)
  const target = join(output, file.replace(/\.ts$/, '.js'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, result.outputText)
}
await writeFile(join(output, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n')
console.log(JSON.stringify({ serviceFiles: files.length, output }))
