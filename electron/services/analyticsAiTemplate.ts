/**
 * 会话风格对比 Prompt 模板
 */

export interface StyleContrastContext {
  sessionDisplayName: string
  selfName: string           // "我" 或 "我（昵称）"
  otherName: string
  stats: {
    totalMessages: number
    selfCount: number
    otherCount: number
    textMessages?: number
    imageMessages?: number
    voiceMessages?: number
    emojiMessages?: number
    firstMessageTime?: number | null
    lastMessageTime?: number | null
    activeDays?: number
  }
  sampleMessages: string  // 已 A/B 标签化的消息样本
}

export function buildStyleContrastPrompt(ctx: StyleContrastContext): string {
  const stats = ctx.stats
  const period = stats.firstMessageTime && stats.lastMessageTime
    ? `${new Date(stats.firstMessageTime).toLocaleDateString('zh-CN')} 至 ${new Date(stats.lastMessageTime).toLocaleDateString('zh-CN')}`
    : '未知'

  return `你是一位温柔、细腻、擅长从对话中提炼性格与关系特征的观察者。请基于下面的统计数据与消息样本，输出一份针对 A（${ctx.selfName}）与 B（${ctx.otherName}）的"风格对比洞察"。

【统计摘要】
- 对话区间：${period}
- 总消息：${stats.totalMessages} 条
- A（${ctx.selfName}）发送：${stats.selfCount} 条
- B（${ctx.otherName}）发送：${stats.otherCount} 条
${stats.activeDays ? `- 活跃天数：${stats.activeDays} 天` : ''}
${stats.textMessages ? `- 文本消息：${stats.textMessages}` : ''}
${stats.imageMessages ? `- 图片消息：${stats.imageMessages}` : ''}
${stats.voiceMessages ? `- 语音消息：${stats.voiceMessages}` : ''}
${stats.emojiMessages ? `- 表情消息：${stats.emojiMessages}` : ''}

【消息样本（A = ${ctx.selfName}，B = ${ctx.otherName}）】
${ctx.sampleMessages}

【输出要求】
1. 使用 Markdown 格式
2. 顶部写一个二级标题（如 "## ${ctx.selfName} × ${ctx.otherName} 的聊天画像"）
3. 接下来用**五维对比表格**展示两人差异，维度包括：
   - 主动性（谁更主动发起话题）
   - 情感浓度（表达是外放还是内敛）
   - 话题偏好（各自关注什么）
   - 节奏（响应速度与消息长度）
   - 关系角色（在关系中扮演什么角色）
4. 表格每格写 1 句具体、落地、有画面感的判断（禁止模板化套话）
5. 表格之后写一段 150-200 字的叙事总结，用温暖但不肉麻的语气描述两人的关系动态
6. 最后给 3 条简短的"相处小贴士"，每条不超过 25 字
7. 禁止出现"根据数据""统计显示""作为一个 AI"等工具感用词
8. 保持观察而非评判的语气；不要给道德结论

直接输出 Markdown，不要寒暄，不要代码块标记。`
}
