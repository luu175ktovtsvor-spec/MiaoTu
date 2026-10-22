import type { IncomingMessage, ServerResponse } from 'node:http'
import { serveFileContent } from './file-response.ts'

export function serveArchiveFile(request: IncomingMessage, response: ServerResponse, path: string, mime: string) {
  return serveFileContent(request, response, { diskPath: path, mime }, { headers: { 'cache-control': 'public, max-age=3600' } })
}
