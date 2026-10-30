import { forEachAsync } from './async-collections.ts'
import { validCanvas } from './canvas-state.ts'
import { DEFAULT_PROJECT_ID } from './workspace-scope.ts'

// Only patches the original node in the latest stored canvas. A browser never has to stay open.
export async function syncCanvasGeneration(generationId, { management, workspaceFiles }: Record<string, any>) {
  const row = (await management.get('SELECT * FROM generations WHERE id=?', generationId))
  if (!row?.user_id) return
  let parameters
  try { parameters = JSON.parse(row.parameters) } catch { return }
  const directory = String(parameters.outputDirectory || '')
  const match = /^assets\/([A-Za-z0-9_-]+)$/.exec(directory)
  if (!match) return
  const project = parameters.workspaceProject || DEFAULT_PROJECT_ID
  const latest = (await management.get("SELECT id FROM generations WHERE user_id=? AND json_extract(parameters,'$.outputDirectory')=? AND COALESCE(json_extract(parameters,'$.workspaceProject'),?)=? ORDER BY created_at DESC,id DESC LIMIT 1",
    row.user_id, directory, DEFAULT_PROJECT_ID, project))
  if (latest?.id !== row.id) return
  const video = (await management.videoResult(row.id))
  const images = video ? [] : (await management.publicGeneration(row)).images
  const resultPath = video?.metadata?.workspacePath || images[0]?.path || ''
  if (row.status === 'succeeded') {
    if (!resultPath) return
    try { await workspaceFiles.locate(row.user_id, resultPath, project) } catch { return }
  }
  for (const entry of (await workspaceFiles.list(row.user_id, project)).filter(entry => /\.json$/i.test(entry.path) && !/^(assets|agent|providers)\//.test(entry.path))) {
    let changed = false
    await management.transaction(async () => {
      let canvas
      try { canvas = JSON.parse((await workspaceFiles.read(row.user_id, entry.path, project)).bytes.toString('utf8')) } catch { return }
      if (!validCanvas(canvas)) return
      const node = canvas.nodes.find(item => item.id === match[1])
      if (!node || !/remote-(image|video)GenerationNode$/.test(node.type || '')) return
      const data = node.data ||= {}
      const before = JSON.stringify(canvas)
      if (row.status === 'queued' || row.status === 'running') data.taskRequestId = row.request_id
      else if (row.status === 'succeeded') {
        const key = video ? 'video' : 'image'
        const existing = data.outputs?.[key]?.value?.url
        // Do not replace a manual upload or a newer task. Completed outputs remain available.
        if (data.taskRequestId && data.taskRequestId !== row.request_id) return
        if (!data.taskRequestId && existing) return
        ;(data.outputs ||= {})[key] = { dataType: video ? 'VIDEO' : 'IMAGE', value: { url: resultPath, mimeType: video?.mime || images[0]?.mime || 'image/png' } }
        if (!video) await forEachAsync(images.slice(1), async (image, index) => {
          const id = data.taskExtraNodeIds?.[index] || image.id
          if (!id || canvas.nodes.some(item => item.id === id)) return
          try { await workspaceFiles.locate(row.user_id, image.path, project) } catch { return }
          canvas.nodes.push({ id, type: 'remote-imageNode', position: { x: Number(node.position?.x || 0) + 380 + index % 2 * 300, y: Number(node.position?.y || 0) + Math.floor(index / 2) * 260 },
            data: { label: data.layerDecomposition ? `图层 ${index + 1}` : `图片 ${index + 2}`,
              outputs: { image: { dataType: 'IMAGE', value: { url: image.path, mimeType: image.mime || 'image/png' } } } } })
        })
        delete data.taskRequestId
        delete data.taskExtraNodeIds
      } else if (data.taskRequestId === row.request_id) delete data.taskRequestId
      if (JSON.stringify(canvas) !== before) {
        await workspaceFiles.upsert(row.user_id, entry.path, 'application/json', Buffer.from(JSON.stringify(canvas)), project)
        changed = true
      }
    })
    // Copies with the same pending request also receive the original result.
    // Manual/completed copies are protected by the task/output guard above.
  }
}
