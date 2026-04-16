/**
 * 角色提示词兑换码服务
 *
 * 管理硬编码兑换码的验证、激活和使用次数追踪。
 * 使用状态通过 ConfigService 持久化到本地。
 */

import { ConfigService } from './config'

// ─── 兑换码定义 ────────────────────────────────────────────────────────────

interface RedeemCodeDef {
  code: string
  uses: number // 可用次数
}

// 30 个单次码
const SINGLE_USE_CODES: RedeemCodeDef[] = [
  'WF7K2M9X', 'WF3N8P4Q', 'WF6R1T5V', 'WF9W2Y7A', 'WF4B8D3F',
  'WF1G5H9J', 'WF7L3M6N', 'WF2P8Q4R', 'WF5S1T7U', 'WF9V3W6X',
  'WF4Y8Z2A', 'WF1C5D9E', 'WF7F3G6H', 'WF2J8K4L', 'WF5M1N7P',
  'WF9Q3R6S', 'WF4T8U2V', 'WF1W5X9Y', 'WF7Z3A6B', 'WF2C8D4E',
  'WF5F1G7H', 'WF9J3K6L', 'WF4M8N2P', 'WF1Q5R9S', 'WF7T3U6V',
  'WF2W8X4Y', 'WF5Z1A7B', 'WF9C3D6E', 'WF4F8G2H', 'WF1J5K9L',
].map(code => ({ code, uses: 1 }))

// 10 个 5 次码
const FIVE_USE_CODES: RedeemCodeDef[] = [
  'WF5XN2KP', 'WF5XP8RT', 'WF5XT1WS', 'WF5XA4DG', 'WF5XF7JM',
  'WF5XL3NQ', 'WF5XQ6SV', 'WF5XU9XB', 'WF5XB2EH', 'WF5XG4KN',
].map(code => ({ code, uses: 5 }))

// 10 个 20 次码
const TWENTY_USE_CODES: RedeemCodeDef[] = [
  'WF20M8R3', 'WF20P4T7', 'WF20S1W5', 'WF20V9A2', 'WF20D6G8',
  'WF20J3L1', 'WF20N7Q4', 'WF20T2U9', 'WF20X5B6', 'WF20E8H3',
].map(code => ({ code, uses: 20 }))

const ALL_CODES: RedeemCodeDef[] = [
  ...SINGLE_USE_CODES,
  ...FIVE_USE_CODES,
  ...TWENTY_USE_CODES,
]

const CODE_MAP = new Map<string, RedeemCodeDef>(
  ALL_CODES.map(def => [def.code.toUpperCase(), def])
)

// ─── 持久化 key ────────────────────────────────────────────────────────────

const CONFIG_KEY_USED_CODES = 'characterPromptUsedCodes'
const CONFIG_KEY_REMAINING = 'characterPromptRemainingUses'

// ─── 服务 ──────────────────────────────────────────────────────────────────

class CharacterPromptRedeemService {
  private config: ConfigService | null = null

  setConfig(config: ConfigService) {
    this.config = config
  }

  /** 获取当前剩余使用次数 */
  getRemainingUses(): number {
    return Number(this.config?.get(CONFIG_KEY_REMAINING) || 0)
  }

  /** 获取已使用的兑换码列表 */
  private getUsedCodes(): string[] {
    const raw = this.config?.get(CONFIG_KEY_USED_CODES)
    if (Array.isArray(raw)) return raw as string[]
    return []
  }

  /** 兑换码验证与激活 */
  redeemCode(code: string): { success: boolean; addedUses?: number; totalRemaining?: number; error?: string } {
    const normalized = code.trim().toUpperCase()

    // 查找兑换码
    const def = CODE_MAP.get(normalized)
    if (!def) {
      return { success: false, error: '兑换码无效' }
    }

    // 检查是否已使用
    const usedCodes = this.getUsedCodes()
    if (usedCodes.includes(normalized)) {
      return { success: false, error: '该兑换码已被使用' }
    }

    // 激活：标记为已使用，增加次数
    usedCodes.push(normalized)
    this.config?.set(CONFIG_KEY_USED_CODES, usedCodes)

    const currentRemaining = this.getRemainingUses()
    const newRemaining = currentRemaining + def.uses
    this.config?.set(CONFIG_KEY_REMAINING, newRemaining)

    return { success: true, addedUses: def.uses, totalRemaining: newRemaining }
  }

  /** 消耗一次使用次数（生成成功后调用） */
  consumeOneUse(): { success: boolean; remaining: number } {
    const current = this.getRemainingUses()
    if (current <= 0) {
      return { success: false, remaining: 0 }
    }
    const newRemaining = current - 1
    this.config?.set(CONFIG_KEY_REMAINING, newRemaining)
    return { success: true, remaining: newRemaining }
  }

  /** 检查是否有剩余次数 */
  hasRemainingUses(): boolean {
    return this.getRemainingUses() > 0
  }
}

export const characterPromptRedeemService = new CharacterPromptRedeemService()
