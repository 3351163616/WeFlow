import { app } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'

type DbKeyResult = { success: boolean; key?: string; error?: string; logs?: string[] }
type ImageKeyResult = { success: boolean; xorKey?: number; aesKey?: string; error?: string }

export class KeyServiceMac {
  private koffi: any = null
  private lib: any = null
  private initialized = false

  private GetDbKey: any = null
  private ScanMemoryForImageKey: any = null
  private FreeString: any = null

  private getDylibPath(): string {
    const isPackaged = app.isPackaged
    const candidates: string[] = []

    if (process.env.WX_KEY_DYLIB_PATH) {
      candidates.push(process.env.WX_KEY_DYLIB_PATH)
    }

    if (isPackaged) {
      candidates.push(join(process.resourcesPath, 'resources', 'libwx_key.dylib'))
      candidates.push(join(process.resourcesPath, 'libwx_key.dylib'))
    } else {
      const cwd = process.cwd()
      candidates.push(join(cwd, 'resources', 'libwx_key.dylib'))
      candidates.push(join(app.getAppPath(), 'resources', 'libwx_key.dylib'))
    }

    for (const path of candidates) {
      if (existsSync(path)) return path
    }

    throw new Error('libwx_key.dylib not found')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    try {
      this.koffi = require('koffi')
      const dylibPath = this.getDylibPath()

      if (!existsSync(dylibPath)) {
        throw new Error('libwx_key.dylib not found: ' + dylibPath)
      }

      this.lib = this.koffi.load(dylibPath)

      this.GetDbKey = this.lib.func('const char* GetDbKey()')
      this.ScanMemoryForImageKey = this.lib.func('const char* ScanMemoryForImageKey(int pid, const char* ciphertext)')
      this.FreeString = this.lib.func('void FreeString(const char* str)')

      this.initialized = true
    } catch (e: any) {
      throw new Error('Failed to initialize KeyServiceMac: ' + e.message)
    }
  }

  async autoGetDbKey(
    timeoutMs = 60_000,
    onStatus?: (message: string, level: number) => void
  ): Promise<DbKeyResult> {
    if (!this.initialized) {
      await this.initialize()
    }

    try {
      onStatus?.('正在获取数据库密钥...', 0)
      
      const keyPtr = this.GetDbKey()
      if (!keyPtr) {
        onStatus?.('获取失败：WeChat 未运行或无法附加', 2)
        return { success: false, error: 'WeChat 未运行或无法附加' }
      }

      const key = this.koffi.decode(keyPtr, 'char', -1)
      this.FreeString(keyPtr)

      onStatus?.('密钥获取成功', 1)
      return { success: true, key }
    } catch (e: any) {
      onStatus?.('获取失败: ' + e.message, 2)
      return { success: false, error: e.message }
    }
  }

  async autoGetImageKey(
    accountPath?: string,
    onStatus?: (message: string) => void,
    wxid?: string
  ): Promise<ImageKeyResult> {
    onStatus?.('macOS 请使用内存扫描方式')
    return { success: false, error: 'macOS 请使用内存扫描方式' }
  }

  async autoGetImageKeyByMemoryScan(
    userDir: string,
    onProgress?: (message: string) => void
  ): Promise<ImageKeyResult> {
    if (!this.initialized) {
      await this.initialize()
    }

    try {
      // 1. 查找模板文件获取密文和 XOR 密钥
      onProgress?.('正在查找模板文件...')
      let result = await this._findTemplateData(userDir, 32)
      let { ciphertext, xorKey } = result
      
      if (ciphertext && xorKey === null) {
        onProgress?.('未找到有效密钥，尝试扫描更多文件...')
        result = await this._findTemplateData(userDir, 100)
        xorKey = result.xorKey
      }
      
      if (!ciphertext) return { success: false, error: '未找到 V2 模板文件，请先在微信中查看几张图片' }
      if (xorKey === null) return { success: false, error: '未能从模板文件中计算出有效的 XOR 密钥' }

      onProgress?.(`XOR 密钥: 0x${xorKey.toString(16).padStart(2, '0')}，正在查找微信进程...`)

      // 2. 找微信 PID
      const pid = await this.findWeChatPid()
      if (!pid) return { success: false, error: '微信进程未运行，请先启动微信' }

      onProgress?.(`已找到微信进程 PID=${pid}，正在扫描内存...`)

      // 3. 持续轮询内存扫描
      const deadline = Date.now() + 60_000
      let scanCount = 0
      while (Date.now() < deadline) {
        scanCount++
        onProgress?.(`第 ${scanCount} 次扫描内存，请在微信中打开图片大图...`)
        const aesKey = await this._scanMemoryForAesKey(pid, ciphertext)
        if (aesKey) {
          onProgress?.('密钥获取成功')
          return { success: true, xorKey, aesKey }
        }
        await new Promise(r => setTimeout(r, 5000))
      }

      return { success: false, error: '60 秒内未找到 AES 密钥' }
    } catch (e: any) {
      return { success: false, error: `内存扫描失败: ${e.message}` }
    }
  }

  private async _findTemplateData(userDir: string, limit: number = 32): Promise<{ ciphertext: Buffer | null; xorKey: number | null }> {
    const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])

    const collect = (dir: string, results: string[], maxFiles: number) => {
      if (results.length >= maxFiles) return
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (results.length >= maxFiles) break
          const full = join(dir, entry.name)
          if (entry.isDirectory()) collect(full, results, maxFiles)
          else if (entry.isFile() && entry.name.endsWith('_t.dat')) results.push(full)
        }
      } catch { }
    }

    const files: string[] = []
    collect(userDir, files, limit)

    files.sort((a, b) => {
      try { return statSync(b).mtimeMs - statSync(a).mtimeMs } catch { return 0 }
    })

    let ciphertext: Buffer | null = null
    const tailCounts: Record<string, number> = {}

    for (const f of files.slice(0, 32)) {
      try {
        const data = readFileSync(f)
        if (data.length < 8) continue

        if (data.subarray(0, 6).equals(V2_MAGIC) && data.length >= 2) {
          const key = `${data[data.length - 2]}_${data[data.length - 1]}`
          tailCounts[key] = (tailCounts[key] ?? 0) + 1
        }

        if (!ciphertext && data.subarray(0, 6).equals(V2_MAGIC) && data.length >= 0x1F) {
          ciphertext = data.subarray(0xF, 0x1F)
        }
      } catch { }
    }

    let xorKey: number | null = null
    let maxCount = 0
    for (const [key, count] of Object.entries(tailCounts)) {
      if (count > maxCount) { 
        maxCount = count
        const [x, y] = key.split('_').map(Number)
        const k = x ^ 0xFF
        if (k === (y ^ 0xD9)) xorKey = k
      }
    }

    return { ciphertext, xorKey }
  }

  private async _scanMemoryForAesKey(pid: number, ciphertext: Buffer): Promise<string | null> {
    const ciphertextHex = ciphertext.toString('hex')
    const aesKeyPtr = this.ScanMemoryForImageKey(pid, ciphertextHex)
    
    if (!aesKeyPtr) return null
    
    const aesKey = this.koffi.decode(aesKeyPtr, 'char', -1)
    this.FreeString(aesKeyPtr)
    
    return aesKey
  }

  private async findWeChatPid(): Promise<number | null> {
    const { execSync } = await import('child_process')
    try {
      const output = execSync('pgrep -x WeChat', { encoding: 'utf8' })
      const pid = parseInt(output.trim())
      return isNaN(pid) ? null : pid
    } catch {
      return null
    }
  }

  cleanup(): void {
    this.lib = null
    this.initialized = false
  }
}
