import { Texture } from 'three'
import { acquireImage } from '../../../../lib/imageResource'

/** Keep the native image alive for upload and WebGL context restoration. */
export async function loadImageTexture(source: string, signal: AbortSignal): Promise<Texture> {
  const resource = await acquireImage(source, signal, 'anonymous')
  try {
    signal.throwIfAborted()
    const texture = new Texture(resource.image)
    const release = () => {
      texture.removeEventListener('dispose', release)
      resource.release()
      texture.image = null
    }
    texture.addEventListener('dispose', release)
    texture.needsUpdate = true
    return texture
  } catch (error) {
    resource.release()
    throw error
  }
}
