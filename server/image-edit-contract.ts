import { inflateSync } from 'node:zlib'

function invalid(message) { throw Object.assign(new Error(message), { status: 422 }) }

export function pngDimensions(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid('编辑原图和选区必须是有效 PNG 图片')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (!width || !height || width > 8192 || height > 8192 || width * height > 36_000_000) invalid('编辑图片尺寸过大')
  return { width, height }
}

// Canvas exports non-interlaced 8-bit RGBA PNG. Validate real alpha, not just MIME.
export function validateMask(bytes, original) {
  const dimensions = pngDimensions(bytes)
  if (dimensions.width !== original.width || dimensions.height !== original.height) invalid('选区尺寸与原图不一致')
  if (bytes[24] !== 8 || bytes[25] !== 6 || bytes[28] !== 0) invalid('选区需要带透明通道的 RGBA PNG')
  const chunks = []
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    if (offset + length + 12 > bytes.length) invalid('选区 PNG 数据不完整')
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  const stride = dimensions.width * 4
  let raw
  try { raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * dimensions.height }) }
  catch { invalid('选区 PNG 数据无法读取') }
  if (raw.length !== (stride + 1) * dimensions.height) invalid('选区像素数据不完整')
  let previous = Buffer.alloc(stride), selected = false, preserved = false
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
  for (let y = 0; y < dimensions.height; y++) {
    const filter = raw[y * (stride + 1)]
    if (filter > 4) invalid('选区 PNG 滤波类型无效')
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? row[x - 4] : 0, up = previous[x], corner = x >= 4 ? previous[x - 4] : 0
      row[x] = (row[x] + (filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, corner) : 0)) & 255
      if (x % 4 === 3) { if (row[x] === 0) selected = true; if (row[x] === 255) preserved = true }
    }
    previous = row
  }
  if (!selected) invalid('请先选中要修改的区域')
  if (!preserved) invalid('局部编辑不能选中整张图片')
  return dimensions
}

export function validateEdit(edit, model, references, parseImageData) {
  if (!edit) return null
  if (!model.supportsEdit || references.length !== 1) invalid('局部编辑需要一张原图')
  const dimensions = pngDimensions(references[0].bytes)
  if (model.provider === 'yunshu') {
    const mask = parseImageData(edit.mask)
    if (mask.mime !== 'image/png') invalid('选区必须是 PNG')
    validateMask(mask.bytes, dimensions)
    return { mode: 'mask', mask, ...dimensions }
  }
  if (model.id.startsWith('doubao-seedream-5-0-') && Array.isArray(edit.annotations)) {
    const annotations = edit.annotations.filter((item) => {
      if (!item || !['box', 'arrow', 'point'].includes(item.tool)) return false
      if (item.tool === 'box') return Array.isArray(item.box) && item.box.length === 4
      if (item.tool === 'arrow') return item.start && item.end
      return item.point
    })
    if (!annotations.length) invalid('请先添加框选、箭头或重点标记')
    for (const item of annotations) {
      const points = item.tool === 'box' ? item.box : item.tool === 'arrow' ? [item.start.x, item.start.y, item.end.x, item.end.y] : [item.point.x, item.point.y]
      if (points.some((number) => !Number.isFinite(number) || number < 0 || number > 1)) invalid('标注坐标无效')
    }
    return { mode: 'annotation', annotations, ...dimensions }
  }
  if (!model.id.startsWith('doubao-seedream-5-0-')) invalid('当前模型不支持框选编辑，请选择 Seedream 5.0')
  const box = edit.box
  if (!Array.isArray(box) || box.length !== 4 || box.some((number) => !Number.isFinite(number) || number < 0 || number > 1) || box[2] <= box[0] || box[3] <= box[1] || (box[2] - box[0]) * (box[3] - box[1]) >= .999) invalid('请框选一个有效的局部区域')
  return { mode: 'box', box, ...dimensions }
}

export function editPrompt(instruction, edit) {
  if (!edit) return instruction
  if (edit.mode === 'mask') return `仅修改蒙版透明区域：${instruction}。保持区域外的主体、构图、颜色与细节尽可能不变。`
  if (edit.mode === 'annotation') {
    const annotations = edit.annotations.map((item) => {
      if (item.tool === 'box') return `<bbox>${item.box.map((value) => Math.round(value * 1000)).join(' ')}</bbox>`
      if (item.tool === 'arrow') return `<arrow>${[item.start.x, item.start.y, item.end.x, item.end.y].map((value) => Math.round(value * 1000)).join(' ')}</arrow>`
      return `<point>${[item.point.x, item.point.y].map((value) => Math.round(value * 1000)).join(' ')}</point>`
    }).join(' ')
    return `按照标注 ${annotations} 指向的位置进行局部修改：${instruction}。保持未标注区域、构图和光线不变，不要绘制标注线或坐标。`
  }
  const [left, top, right, bottom] = edit.box.map((value) => Math.round(value * 1000))
  return `在原图中仅修改框选区域 <bbox>${left} ${top} ${right} ${bottom}</bbox>（坐标归一化到 0–1000，依次为左、上、右、下）：${instruction}。保持框外内容、构图和光线不变，不要绘制框线或坐标。`
}
