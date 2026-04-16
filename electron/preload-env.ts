import { join, dirname } from 'path'
import { readFileSync, existsSync } from 'fs'

/**
 * 强制将本地资源目录添加到 PATH 最前端，确保优先加载本地 DLL
 * 解决系统中存在冲突版本的数据服务导致的应用崩溃问题
 */
function enforceLocalDllPriority() {
    const isDev = !!process.env.VITE_DEV_SERVER_URL
    const sep = process.platform === 'win32' ? ';' : ':'

    let possiblePaths: string[] = []

    if (isDev) {
        // 开发环境
        possiblePaths.push(join(process.cwd(), 'resources'))
    } else {
        // 生产环境
        possiblePaths.push(dirname(process.execPath))
        if (process.resourcesPath) {
            possiblePaths.push(process.resourcesPath)
        }
    }

    const dllPaths = possiblePaths.join(sep)

    if (process.env.PATH) {
        process.env.PATH = dllPaths + sep + process.env.PATH
    } else {
        process.env.PATH = dllPaths
    }


}

/**
 * 极简 .env.local 加载器（仅开发环境）。
 * 用于注入 WEFLOW_BUILTIN_API_* 等敏感配置，避免硬编码进仓库。
 * 格式：KEY=VALUE，每行一条，# 开头为注释。
 */
function loadDotEnvLocal() {
    const isDev = !!process.env.VITE_DEV_SERVER_URL
    if (!isDev) return
    const envPath = join(process.cwd(), '.env.local')
    if (!existsSync(envPath)) return
    try {
        const text = readFileSync(envPath, 'utf-8')
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim()
            if (!line || line.startsWith('#')) continue
            const eq = line.indexOf('=')
            if (eq <= 0) continue
            const key = line.slice(0, eq).trim()
            let value = line.slice(eq + 1).trim()
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1)
            }
            if (!(key in process.env)) process.env[key] = value
        }
    } catch (e) {
        console.error('[WeFlow] Failed to load .env.local:', e)
    }
}

try {
    enforceLocalDllPriority()
    loadDotEnvLocal()
} catch (e) {
    console.error('[WeFlow] Failed to enforce local service priority:', e)
}
