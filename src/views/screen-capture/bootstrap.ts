import type { Event, UnlistenFn } from '@tauri-apps/api/event'
import { createApp, defineComponent, h, ref, shallowRef } from 'vue'
import ScreenCaptureOverlay, { type ScreenCaptureOverlayHandle } from './ScreenCaptureOverlay.vue'
import {
  createCaptureOverlaySession,
  type CaptureDeliveryFailed,
  type CaptureOverlayMount,
  type CaptureOverlayMountOptions,
  type CaptureOverlaySessionEnded,
  type CaptureTargetUnavailable,
} from './capture-overlay-session'
import { captureMessagesForLanguages, type CaptureMessages } from './capture-localization'
import type { CaptureFrameAvailable, CaptureInvoke, CaptureListen } from './capture-transport'
import { createCaptureTransport, parseOverlayGeneration } from './capture-transport'
import { CAPTURE_OVERLAY_SESSION_ENDED_EVENT } from '@/lib/screen-capture/capture-events'
import './screen-capture.scss'

const TARGET_UNAVAILABLE_EVENT = 'screen-capture://target-unavailable'
const DELIVERY_FAILED_EVENT = 'screen-capture://delivery-failed'

function mountOverlay(root: HTMLElement, image: ImageData, options: CaptureOverlayMountOptions, messages: CaptureMessages): CaptureOverlayMount {
  const canConfirm = ref(options.canConfirm)
  const frame = shallowRef<ImageData | null>(image)
  const overlay = ref<ScreenCaptureOverlayHandle | null>(null)
  let disposed = false
  const app = createApp(
    defineComponent({
      name: 'ScreenCaptureBootstrapRoot',
      setup: () => () =>
        h(ScreenCaptureOverlay, {
          ref: overlay,
          frame: frame.value,
          canConfirm: canConfirm.value,
          messages,
          onExport: options.onExport,
          onCancel: options.onCancel,
          onFrameInstalled: () => {
            frame.value = null
          },
        }),
    })
  )

  root.replaceChildren()
  try {
    app.mount(root)
    const source = root.querySelector<HTMLCanvasElement>('.screen-capture-overlay__source')
    if (!overlay.value || source?.width !== image.width || source.height !== image.height) {
      throw new Error('screen capture frozen pixels were not installed')
    }
  } catch (error) {
    frame.value = null
    try {
      overlay.value?.dispose()
      app.unmount()
    } catch {
      // Preserve the mount/validation error that owns this cleanup path.
    }
    root.replaceChildren()
    throw error
  }

  return {
    setCanConfirm(value) {
      if (!disposed) canConfirm.value = value
    },
    dispose() {
      if (disposed) return
      disposed = true
      overlay.value?.dispose()
      app.unmount()
      root.replaceChildren()
    },
  }
}

export async function bootstrapScreenCapture(): Promise<void> {
  document.documentElement.classList.add('tauri', 'screen-capture')
  const root = document.querySelector<HTMLElement>('#app')
  if (!root) throw new Error('screen capture root is unavailable')

  root.dataset.bootstrap = 'screen-capture'
  const overlayGeneration = parseOverlayGeneration(window.location.search)
  const messages = captureMessagesForLanguages(navigator.languages.length ? navigator.languages : [navigator.language])
  const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')])
  const captureInvoke: CaptureInvoke = (command, args, options) => invoke(command, args, options)
  const captureListen: CaptureListen = (event, handler) => listen<CaptureFrameAvailable>(event, (message: Event<CaptureFrameAvailable>) => handler(message)).then((unlisten: UnlistenFn) => unlisten)
  const overlaySession = createCaptureOverlaySession({
    overlayGeneration,
    invoke: captureInvoke,
    mount: (image, options) => mountOverlay(root, image, options, messages),
  })

  const unlisteners: UnlistenFn[] = []
  let transport: Awaited<ReturnType<typeof createCaptureTransport>> | null = null
  let disposed = false

  const dispose = () => {
    if (disposed) return
    disposed = true
    transport?.dispose()
    transport = null
    for (const unlisten of unlisteners.splice(0)) unlisten()
    overlaySession.dispose()
  }

  try {
    unlisteners.push(
      await listen<CaptureTargetUnavailable>(TARGET_UNAVAILABLE_EVENT, ({ payload }) => {
        overlaySession.targetUnavailable(payload)
      })
    )
    unlisteners.push(
      await listen<CaptureOverlaySessionEnded>(CAPTURE_OVERLAY_SESSION_ENDED_EVENT, ({ payload }) => {
        overlaySession.sessionEnded(payload)
      })
    )
    unlisteners.push(
      await listen<CaptureDeliveryFailed>(DELIVERY_FAILED_EVENT, ({ payload }) => {
        overlaySession.deliveryFailed(payload)
      })
    )
    transport = await createCaptureTransport({
      overlayGeneration,
      invoke: captureInvoke,
      listen: captureListen,
      present: (image, frame) => overlaySession.present(image, frame),
    })
  } catch (error) {
    dispose()
    throw error
  }

  window.addEventListener(
    'pagehide',
    () => {
      dispose()
      void captureInvoke('screen_capture_unavailable', { overlayGeneration })
    },
    { once: true }
  )
}
