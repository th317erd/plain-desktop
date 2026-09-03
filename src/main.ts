import { runSelectedBootstrap } from './bootstrap/select-bootstrap'

void runSelectedBootstrap(window.location.pathname, __IS_TAURI__, {
  loadFullApp: async () => {
    const { bootstrapFullApp } = await import('./bootstrap/full-app')
    await bootstrapFullApp()
  },
  loadScreenCapture: async () => {
    const { bootstrapScreenCapture } = await import('./views/screen-capture/bootstrap')
    await bootstrapScreenCapture()
  },
})
