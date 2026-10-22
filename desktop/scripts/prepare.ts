import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { compileDesktop } from '../../scripts/compile-desktop.ts'
const root = fileURLToPath(new URL('../../', import.meta.url))
await new Promise<void>((done, fail) => {
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--prefix', resolve(root, 'desktop/renderer'), 'run', 'build'], { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192' } })
  child.on('error', fail); child.on('exit', code => code === 0 ? done() : fail(new Error('工作台构建失败')))
})
console.log('Desktop runtime:', await compileDesktop())
