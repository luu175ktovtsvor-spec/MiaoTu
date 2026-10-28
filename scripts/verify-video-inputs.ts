import assert from 'node:assert/strict'
import { parseVideoFrames, safeOutputDirectory } from '../server/video-api.ts'

assert.equal(parseVideoFrames(undefined), undefined)
assert.equal(parseVideoFrames(''), undefined)
assert.equal(parseVideoFrames('1.5'), 1.5, 'fractional frame counts must remain fractional until validation')
assert.equal(parseVideoFrames(29), 29)

assert.equal(safeOutputDirectory('renders/project_1'), 'renders/project_1')
assert.equal(safeOutputDirectory('/renders/project_1/'), 'renders/project_1')
for (const value of ['.', '..', '../outside', 'renders/../outside', 'renders/./project', 'renders//project', 'renders/项目']) {
  assert.equal(safeOutputDirectory(value), '', `unsafe output directory accepted: ${value}`)
}

console.log('Video input boundary verification passed: fractional frames and traversal paths are rejected safely.')
