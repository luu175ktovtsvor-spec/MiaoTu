import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'

type LocatedFile = { diskPath?: string | null; bytes?: Uint8Array | null }
const failure = (message: string, status: number) => Object.assign(new Error(message), { status })

// The caller has already resolved account/project access through locate().
// Bound allocation before reading, and stat/read through the same descriptor.
export function readWorkspaceRange(file: LocatedFile, { offset = 0, limit, maxSize = Infinity }: {
  offset?: number; limit: number; maxSize?: number;
}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0) throw failure('读取位置或长度无效', 422)
  const lengthFor = (size: number) => {
    if (size > maxSize) throw failure('文件超过允许的读取大小', 413)
    if (offset > size) throw failure('读取偏移必须是文件范围内的非负整数字节位置', 422)
    return Math.min(limit, size - offset)
  }
  if (!file.diskPath) {
    const bytes = file.bytes ? Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength) : Buffer.alloc(0)
    return { size: bytes.length, bytes: bytes.subarray(offset, offset + lengthFor(bytes.length)) }
  }
  const descriptor = openSync(file.diskPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile()) throw failure('读取目标不是普通文件', 422)
    const length = lengthFor(info.size)
    const bytes = Buffer.allocUnsafe(length)
    let received = 0
    while (received < length) {
      const count = readSync(descriptor, bytes, received, length - received, offset + received)
      if (!count) throw failure('文件读取不完整，请重新读取', 409)
      received += count
    }
    return { size: info.size, bytes }
  } finally { closeSync(descriptor) }
}
