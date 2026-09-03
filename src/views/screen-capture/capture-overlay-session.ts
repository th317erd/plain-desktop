import type { CaptureExportPayload } from './ScreenCaptureOverlay.vue'
import type { CaptureExportAction } from './ScreenCaptureToolbar.vue'
import { createCaptureExportController, type CaptureExportControllerInvoke } from './capture-export-controller'
import type { CaptureFrameAvailable } from './capture-transport'

export interface CaptureTargetUnavailable {
  sessionId: string
  overlayGeneration: number
}

export interface CaptureOverlaySessionEnded {
  sessionId: string
  overlayGeneration: number
  outcome: 'completed' | 'cancelled' | 'saved' | 'copied' | 'failed'
}

export interface CaptureOverlayMountOptions {
  canConfirm: boolean
  onExport(action: CaptureExportAction, payload: CaptureExportPayload): Promise<void>
  onCancel(): Promise<void>
}

export interface CaptureOverlayMount {
  setCanConfirm(value: boolean): void
  dispose(): void
}

export interface CaptureOverlaySessionDependencies {
  overlayGeneration: number
  invoke: CaptureExportControllerInvoke
  mount(image: ImageData, options: CaptureOverlayMountOptions): CaptureOverlayMount
}

export interface CaptureOverlaySession {
  present(image: ImageData, frame: CaptureFrameAvailable): Promise<void>
  targetUnavailable(payload: CaptureTargetUnavailable): void
  sessionEnded(payload: CaptureOverlaySessionEnded): void
  dispose(): void
}

interface ActiveOverlay {
  sessionId: string
  mount: CaptureOverlayMount
  exportController: ReturnType<typeof createCaptureExportController>
}

export function createCaptureOverlaySession(deps: CaptureOverlaySessionDependencies): CaptureOverlaySession {
  let active: ActiveOverlay | null = null
  let unavailableSessionId: string | null = null
  let disposed = false

  function clearActive(): void {
    if (!active) return
    const current = active
    active = null
    current.exportController.dispose()
    current.mount.dispose()
  }

  async function present(image: ImageData, frame: CaptureFrameAvailable): Promise<void> {
    if (disposed) throw new Error('capture overlay session is disposed')
    if (frame.overlayGeneration !== deps.overlayGeneration || frame.descriptor.sessionId !== frame.sessionId) {
      throw new Error('capture frame session metadata is invalid')
    }
    clearActive()
    const exportController = createCaptureExportController({
      sessionId: frame.sessionId,
      overlayGeneration: deps.overlayGeneration,
      invoke: deps.invoke,
    })
    const mount = deps.mount(image, {
      canConfirm: frame.canConfirm && unavailableSessionId !== frame.sessionId,
      onExport: (action, payload) => exportController.export(action, payload),
      onCancel: async () => {
        await deps.invoke('screen_capture_cancel', {
          sessionId: frame.sessionId,
          overlayGeneration: deps.overlayGeneration,
        })
      },
    })
    active = { sessionId: frame.sessionId, mount, exportController }
    if (unavailableSessionId === frame.sessionId) unavailableSessionId = null
  }

  function targetUnavailable(payload: CaptureTargetUnavailable): void {
    if (disposed || payload.overlayGeneration !== deps.overlayGeneration) return
    if (active?.sessionId === payload.sessionId) {
      active.mount.setCanConfirm(false)
      return
    }
    unavailableSessionId = payload.sessionId
  }

  function sessionEnded(payload: CaptureOverlaySessionEnded): void {
    if (disposed || payload.overlayGeneration !== deps.overlayGeneration) return
    if (active?.sessionId === payload.sessionId) clearActive()
    if (unavailableSessionId === payload.sessionId) unavailableSessionId = null
  }

  return {
    present,
    targetUnavailable,
    sessionEnded,
    dispose() {
      if (disposed) return
      disposed = true
      unavailableSessionId = null
      clearActive()
    },
  }
}
