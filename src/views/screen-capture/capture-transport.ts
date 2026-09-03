export const CAPTURE_PROTOCOL_VERSION = 1
export const FRAME_AVAILABLE_EVENT = 'screen-capture://frame-available'

export interface PhysicalPoint {
  x: number
  y: number
}

export interface PhysicalSize {
  width: number
  height: number
}

export interface LogicalPoint {
  x: number
  y: number
}

export interface LogicalSize {
  width: number
  height: number
}

export interface CaptureMonitorGeometry {
  id: string
  physicalOrigin: PhysicalPoint
  physicalSize: PhysicalSize
  logicalOrigin: LogicalPoint
  logicalSize: LogicalSize
  scaleFactor: number
}

export interface CaptureFrameDescriptor {
  sessionId: string
  monitor: CaptureMonitorGeometry
  width: number
  height: number
  stride: number
  pixelFormat: 'rgba8'
  byteLen: number
}

export interface CaptureFrameAvailable {
  sessionId: string
  overlayGeneration: number
  descriptor: CaptureFrameDescriptor
  canConfirm: boolean
}

export interface CaptureEvent<T> {
  payload: T
}

export type CaptureUnlisten = () => void
export type CaptureListen = (event: string, handler: (event: CaptureEvent<CaptureFrameAvailable>) => void | Promise<void>) => Promise<CaptureUnlisten>
export interface CaptureInvokeOptions {
  headers: Record<string, string>
}

export type CaptureInvoke = (command: string, args?: Record<string, unknown> | ArrayBuffer, options?: CaptureInvokeOptions) => Promise<unknown>

export interface CaptureTransportDependencies {
  overlayGeneration: number
  listen: CaptureListen
  invoke: CaptureInvoke
  present(image: ImageData, frame: CaptureFrameAvailable): Promise<void>
}

export interface CaptureTransport {
  dispose(): void
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid capture ${field}`)
}

export function parseOverlayGeneration(search: string): number {
  const value = Number(new URLSearchParams(search).get('overlayGeneration'))
  requirePositiveInteger(value, 'overlay generation')
  return value
}

export function frameBytesToImageData(descriptor: CaptureFrameDescriptor, buffer: ArrayBuffer): ImageData {
  requirePositiveInteger(descriptor.width, 'width')
  requirePositiveInteger(descriptor.height, 'height')
  requirePositiveInteger(descriptor.stride, 'stride')
  requirePositiveInteger(descriptor.byteLen, 'byte length')
  if (descriptor.pixelFormat !== 'rgba8') throw new Error('unsupported capture pixel format')

  const rowBytes = descriptor.width * 4
  if (!Number.isSafeInteger(rowBytes) || descriptor.stride < rowBytes) throw new Error('invalid capture stride')
  const expectedByteLength = descriptor.stride * descriptor.height
  if (!Number.isSafeInteger(expectedByteLength) || descriptor.byteLen !== expectedByteLength || buffer.byteLength !== expectedByteLength) {
    throw new Error('capture byte length does not match its descriptor')
  }

  if (descriptor.stride === rowBytes) {
    return new ImageData(new Uint8ClampedArray(buffer), descriptor.width, descriptor.height)
  }

  const packed = new Uint8ClampedArray(rowBytes * descriptor.height)
  const source = new Uint8Array(buffer)
  for (let row = 0; row < descriptor.height; row += 1) {
    packed.set(source.subarray(row * descriptor.stride, row * descriptor.stride + rowBytes), row * rowBytes)
  }
  return new ImageData(packed, descriptor.width, descriptor.height)
}

function errorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return detail.slice(0, 512)
}

export async function createCaptureTransport(deps: CaptureTransportDependencies): Promise<CaptureTransport> {
  requirePositiveInteger(deps.overlayGeneration, 'overlay generation')
  let disposed = false
  let processingSessionId: string | null = null

  const unlisten = await deps.listen(FRAME_AVAILABLE_EVENT, async ({ payload }) => {
    if (disposed) return
    if (processingSessionId) {
      await deps.invoke('screen_capture_fail', {
        sessionId: payload.sessionId,
        overlayGeneration: deps.overlayGeneration,
        code: 'overlay_busy',
        detail: 'the capture overlay is already presenting another frame',
      })
      return
    }

    processingSessionId = payload.sessionId
    try {
      if (payload.overlayGeneration !== deps.overlayGeneration) {
        await deps.invoke('screen_capture_fail', {
          sessionId: payload.sessionId,
          overlayGeneration: deps.overlayGeneration,
          code: 'stale_overlay_generation',
          detail: 'capture frame belongs to another overlay generation',
        })
        return
      }
      if (typeof payload.canConfirm !== 'boolean') throw new Error('capture target metadata is invalid')
      if (payload.descriptor.sessionId !== payload.sessionId) throw new Error('capture session metadata does not match the event')
      const raw = await deps.invoke('screen_capture_take_frame', {
        sessionId: payload.sessionId,
        overlayGeneration: deps.overlayGeneration,
      })
      if (disposed) return
      if (!(raw instanceof ArrayBuffer)) throw new Error('capture frame did not use binary IPC')
      const image = frameBytesToImageData(payload.descriptor, raw)
      await deps.present(image, payload)
      if (disposed) return
      await deps.invoke('screen_capture_frame_presented', {
        sessionId: payload.sessionId,
        overlayGeneration: deps.overlayGeneration,
      })
    } catch (error) {
      await deps.invoke('screen_capture_fail', {
        sessionId: payload.sessionId,
        overlayGeneration: deps.overlayGeneration,
        code: 'frame_decode_failed',
        detail: errorDetail(error),
      })
    } finally {
      processingSessionId = null
    }
  })

  try {
    await deps.invoke('screen_capture_ready', {
      overlayGeneration: deps.overlayGeneration,
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
    })
  } catch (error) {
    unlisten()
    throw error
  }

  return {
    dispose() {
      disposed = true
      unlisten()
    },
  }
}
