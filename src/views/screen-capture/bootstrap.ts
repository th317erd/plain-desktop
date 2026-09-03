import type { Event, UnlistenFn } from '@tauri-apps/api/event'
import { createApp, defineComponent, h, ref } from 'vue'
import ScreenCaptureOverlay, { type ScreenCaptureOverlayHandle } from './ScreenCaptureOverlay.vue'
import { createCaptureOverlaySession, type CaptureOverlayMount, type CaptureOverlayMountOptions, type CaptureOverlaySessionEnded, type CaptureTargetUnavailable } from './capture-overlay-session'
import { captureMessagesForLanguages, type CaptureMessages } from './capture-localization'
import type { CaptureFrameAvailable, CaptureInvoke, CaptureListen } from './capture-transport'
import { createCaptureTransport, parseOverlayGeneration } from './capture-transport'
import './screen-capture.scss'

const TARGET_UNAVAILABLE_EVENT = 'screen-capture://target-unavailable'
const SESSION_ENDED_EVENT = 'screen-capture://session-ended'

function mountOverlay(root: HTMLElement, image: ImageData, options: CaptureOverlayMountOptions, messages: CaptureMessages): CaptureOverlayMount {
  const canConfirm = ref(options.canConfirm)
  const overlay = ref<ScreenCaptureOverlayHandle | null>(null)
  let disposed = false
  const app = createApp(
    defineComponent({
      name: 'ScreenCaptureBootstrapRoot',
      setup: () => () =>
        h(ScreenCaptureOverlay, {
          ref: overlay,
          frame: image,
          canConfirm: canConfirm.value,
          messages,
          onExport: options.onExport,
          onCancel: options.onCancel,
        }),
    })
  )

  root.replaceChildren()
  app.mount(root)
  const source = root.querySelector<HTMLCanvasElement>('.screen-capture-overlay__source')
  if (!overlay.value || source?.width !== image.width || source.height !== image.height) {
    app.unmount()
    root.replaceChildren()
    throw new Error('screen capture frozen pixels were not installed')
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
      await listen<CaptureOverlaySessionEnded>(SESSION_ENDED_EVENT, ({ payload }) => {
        overlaySession.sessionEnded(payload)
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
