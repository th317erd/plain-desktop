import { getCaptureClient, type CaptureClient, type CaptureClientError, type CaptureConsumerRegistration, type CaptureStartResponse } from './capture-client'

export interface ChatCaptureDestination {
  readonly chatId: string
  readonly channelId: string
  readonly appDir: string
}

export type ChatCaptureConsumer = (file: File, destination: ChatCaptureDestination) => Promise<void>

export interface ChatCaptureTarget {
  activate(destination: ChatCaptureDestination): string
  deactivate(): void
  start(destination: ChatCaptureDestination): Promise<CaptureStartResponse>
  dispose(): void
}

function requireNonBlank(value: string, field: string): void {
  if (!value.trim()) throw new Error(`capture ${field} is required`)
}

export function snapshotChatCaptureDestination(destination: ChatCaptureDestination): ChatCaptureDestination {
  requireNonBlank(destination.chatId, 'chat id')
  requireNonBlank(destination.appDir, 'app directory')
  return Object.freeze({
    chatId: destination.chatId,
    channelId: destination.channelId,
    appDir: destination.appDir,
  })
}

function sameDestination(left: ChatCaptureDestination | null, right: ChatCaptureDestination): boolean {
  return left?.chatId === right.chatId && left.channelId === right.channelId && left.appDir === right.appDir
}

/**
 * Owns the chat consumer registration separately from CaptureClient's native
 * session. Replacing an activation creates both a new immutable destination
 * closure and a new opaque target token.
 */
export function createChatCaptureTarget(client: CaptureClient, consume: ChatCaptureConsumer): ChatCaptureTarget {
  let registration: CaptureConsumerRegistration | null = null
  let destination: ChatCaptureDestination | null = null
  let active = false
  let disposed = false

  function replace(next: ChatCaptureDestination): string {
    const frozen = snapshotChatCaptureDestination(next)
    const previous = registration
    registration = null
    destination = null
    active = false
    previous?.deactivate()
    previous?.dispose()
    const nextRegistration = client.registerConsumer((file) => consume(file, frozen))
    let token: string
    try {
      token = nextRegistration.activate()
    } catch (error) {
      nextRegistration.dispose()
      throw error
    }
    registration = nextRegistration
    destination = frozen
    active = true
    return token
  }

  return {
    activate(next) {
      if (disposed) throw new Error('capture target is disposed')
      return replace(next)
    },
    deactivate() {
      if (!active) return
      active = false
      registration?.deactivate()
    },
    async start(next) {
      if (disposed) throw new Error('capture target is disposed')
      if (!active) throw new Error('capture target is not active')
      const frozen = snapshotChatCaptureDestination(next)
      if (!sameDestination(destination, frozen)) replace(frozen)
      return client.startComposerCapture()
    },
    dispose() {
      if (disposed) return
      disposed = true
      active = false
      registration?.dispose()
      registration = null
      destination = null
    },
  }
}

/** Load and install the per-webview client without any eager Tauri imports. */
export async function getTauriCaptureClient(onError: (error: CaptureClientError) => void): Promise<CaptureClient> {
  const [{ invoke }, { listen }, { getCurrentWindow }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event'), import('@tauri-apps/api/window')])
  return getCaptureClient({
    windowLabel: getCurrentWindow().label,
    invoke,
    listen: async (event, handler) =>
      listen(event, (incoming) => {
        void handler({ payload: incoming.payload })
      }),
    onError,
  })
}
