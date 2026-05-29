import '@google/model-viewer'
import type { ModelViewerElement } from '@google/model-viewer'
import skyboxImage from '@/assets/image/qwantani_moonrise_puresky_8k.jpg'

/**
 * Render a still thumbnail of a 3D model (`.glb`) on-device using a hidden
 * `<model-viewer>` element. Chat clients (Telegram, Slack) have no inline
 * glTF preview, so Home Agent ships 3D models as a document accompanied by
 * this thumbnail sent as a photo.
 *
 * The model URL (e.g. an `aipg-media://…` URL) is handed to `<model-viewer>`
 * directly, exactly like `Model3DViewer.vue`. model-viewer derives the loader
 * from the `.glb` extension and the `aipg-media://` protocol is fetch-able in
 * the renderer, so no base64/data-URI conversion is needed (a `data:` URI
 * without an extension makes the loader hang).
 *
 * The same `skybox-image` as `Model3DViewer.vue` is used so the thumbnail is
 * lit and framed exactly like the in-app preview (clean sky backdrop) instead
 * of a flat black background.
 *
 * Resolves with JPEG bytes (base64, no data-URI prefix). Rejects on load
 * timeout / failure so callers can fall back to sending the model without a
 * thumbnail.
 */
export async function render3dThumbnail(
  src: string,
  opts?: { width?: number; height?: number; timeoutMs?: number },
): Promise<{ base64: string; mime: 'image/jpeg' }> {
  const width = opts?.width ?? 768
  const height = opts?.height ?? 768
  const timeoutMs = opts?.timeoutMs ?? 45_000

  const viewer = document.createElement('model-viewer') as ModelViewerElement
  viewer.setAttribute('camera-controls', '')
  viewer.setAttribute('exposure', '1')
  // Match the in-app Model3DViewer: skybox provides image-based lighting and a
  // pleasant backdrop so the capture isn't an unlit model on flat black.
  viewer.setAttribute('skybox-image', skyboxImage)
  // Force an immediate load: the default `loading="auto"` is lazy via an
  // IntersectionObserver and never reveals/renders a model that is parked
  // off-screen, so `load` would never fire and capture would time out.
  viewer.setAttribute('loading', 'eager')
  // Keep the element on-screen (so it intersects the viewport and renders a
  // real WebGL frame) but visually imperceptible and non-interactive.
  viewer.style.position = 'fixed'
  viewer.style.left = '0'
  viewer.style.bottom = '0'
  viewer.style.width = `${width}px`
  viewer.style.height = `${height}px`
  viewer.style.opacity = '0.01'
  viewer.style.pointerEvents = 'none'
  viewer.style.zIndex = '-1'
  viewer.style.backgroundColor = 'transparent'

  document.body.appendChild(viewer)

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('render3dThumbnail: model load timed out'))
      }, timeoutMs)

      const onLoad = () => {
        cleanup()
        resolve()
      }
      const onError = (e: Event) => {
        cleanup()
        reject(
          new Error(
            `render3dThumbnail: model failed to load (${(e as ErrorEvent).message ?? 'error'})`,
          ),
        )
      }
      function cleanup() {
        clearTimeout(timer)
        viewer.removeEventListener('load', onLoad)
        viewer.removeEventListener('error', onError)
      }

      viewer.addEventListener('load', onLoad)
      viewer.addEventListener('error', onError)
      viewer.src = src
    })

    await viewer.updateComplete
    // The `load` event fires for the model; give the (large) skybox a brief
    // moment to finish so it shows up in the capture rather than black.
    await new Promise((r) => setTimeout(r, 800))

    const blob = await viewer.toBlob({
      mimeType: 'image/jpeg',
      qualityArgument: 0.9,
      // Square capture (the element is square): a centered model reads better
      // as a chat thumbnail than the model's own (often tall) ideal aspect.
      idealAspect: false,
    })
    const base64 = await blobToBase64(blob)
    return { base64, mime: 'image/jpeg' }
  } finally {
    viewer.remove()
  }
}

/** Read a Blob into base64 (no `data:…;base64,` prefix). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const comma = result.indexOf('base64,')
      if (comma === -1) {
        reject(new Error('render3dThumbnail: unexpected FileReader output'))
        return
      }
      resolve(result.slice(comma + 'base64,'.length))
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}
