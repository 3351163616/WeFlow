import { homedir, tmpdir } from 'os'
import { join } from 'path'

type RuntimeRequire = (id: string) => any

let cachedElectron: any | null | false = null

export function isWorkerRuntime(): boolean {
  return process.env.WEFLOW_WORKER === '1'
}

export function getElectronModule(): any | null {
  if (isWorkerRuntime()) return null
  if (cachedElectron !== null) return cachedElectron || null
  try {
    const runtimeRequire = (0, eval)('require') as RuntimeRequire
    cachedElectron = runtimeRequire('electron')
  } catch {
    cachedElectron = false
  }
  return cachedElectron || null
}

export function getElectronApp(): any | null {
  return getElectronModule()?.app || null
}

export function getElectronBrowserWindow(): any | null {
  return getElectronModule()?.BrowserWindow || null
}

export function getElectronDialog(): any | null {
  return getElectronModule()?.dialog || null
}

export function getElectronSafeStorage(): any | null {
  return getElectronModule()?.safeStorage || null
}

export function getElectronPath(name: string): string | null {
  try {
    const getter = getElectronApp()?.getPath
    if (typeof getter === 'function') {
      return getter(name)
    }
  } catch {
    // fall through to caller fallback
  }
  return null
}

export function getAppPathFallback(): string {
  try {
    const getter = getElectronApp()?.getAppPath
    if (typeof getter === 'function') {
      return getter()
    }
  } catch {
    // fall through
  }
  return process.cwd()
}

export function getPathFallback(name: string): string {
  const fromElectron = getElectronPath(name)
  if (fromElectron) return fromElectron

  const home = homedir()
  switch (name) {
    case 'userData': {
      const workerUserDataPath = String(process.env.WEFLOW_USER_DATA_PATH || process.env.WEFLOW_CONFIG_CWD || '').trim()
      if (workerUserDataPath) return workerUserDataPath
      if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'WeFlow')
      if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'WeFlow')
      return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'WeFlow')
    }
    case 'documents':
      return join(home, 'Documents')
    case 'desktop':
      return join(home, 'Desktop')
    case 'downloads':
      return join(home, 'Downloads')
    case 'temp':
      return tmpdir()
    case 'appData':
      return process.platform === 'win32' && process.env.APPDATA ? process.env.APPDATA : join(home, '.config')
    default:
      return process.cwd()
  }
}

export function isElectronAppPackaged(): boolean {
  const app = getElectronApp()
  if (typeof app?.isPackaged === 'boolean') return app.isPackaged
  return Boolean((process as any).resourcesPath && process.env.NODE_ENV !== 'development')
}
