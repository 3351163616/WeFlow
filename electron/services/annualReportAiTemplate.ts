import type { AnnualReportData } from './annualReportService'

/**
 * 把年度报告的聚合统计 JSON 压缩成紧凑的 Prompt 上下文
 */
function buildReportContext(data: AnnualReportData): string {
  const lines: string[] = []
  lines.push(`年份：${data.year === 0 ? '全部时间' : data.year}`)
  lines.push(`总消息：${data.totalMessages}`)
  lines.push(`好友数：${data.totalFriends}`)

  if (data.coreFriends && data.coreFriends.length > 0) {
    const top5 = data.coreFriends.slice(0, 5)
    lines.push(`核心好友 Top5：${top5.map(f => `${f.displayName}(${f.messageCount}条, 发出${f.sentCount}/接收${f.receivedCount})`).join('、')}`)
  }
  if (data.mutualFriend) {
    const mf = data.mutualFriend
    lines.push(`最双向好友：${mf.displayName}，你发${mf.sentCount} TA回${mf.receivedCount}，比值 ${mf.ratio.toFixed(2)}`)
  }
  if (data.peakDay) {
    lines.push(`最高峰日：${data.peakDay.date}，${data.peakDay.messageCount}条${data.peakDay.topFriend ? `，主要对象 ${data.peakDay.topFriend}` : ''}`)
  }
  if (data.longestStreak) {
    lines.push(`最长连续聊天：和 ${data.longestStreak.friendName} 连续 ${data.longestStreak.days} 天（${data.longestStreak.startDate} ~ ${data.longestStreak.endDate}）`)
  }
  if (data.midnightKing) {
    lines.push(`深夜之王：${data.midnightKing.displayName}，占夜间消息 ${data.midnightKing.percentage}%`)
  }
  if (data.socialInitiative) {
    const si = data.socialInitiative
    lines.push(`社交主动性：主动发起 ${si.initiatedChats}次 / 被动接收 ${si.receivedChats}次，主动率 ${(si.initiativeRate * 100).toFixed(0)}%`)
  }
  if (data.responseSpeed) {
    lines.push(`响应速度：平均 ${Math.round(data.responseSpeed.avgResponseTime)}分钟，最快对象 ${data.responseSpeed.fastestFriend}`)
  }
  if (data.topPhrases && data.topPhrases.length > 0) {
    lines.push(`常用语 Top：${data.topPhrases.slice(0, 8).map(p => `${p.phrase}(${p.count})`).join('、')}`)
  }
  if (data.lostFriend) {
    lines.push(`渐行渐远：${data.lostFriend.displayName}，${data.lostFriend.periodDesc}（早期${data.lostFriend.earlyCount}→后期${data.lostFriend.lateCount}条）`)
  }
  if (data.snsStats && data.snsStats.totalPosts > 0) {
    lines.push(`朋友圈：发布 ${data.snsStats.totalPosts} 条`)
  }
  if (data.monthlyTopFriends && data.monthlyTopFriends.length > 0) {
    lines.push(`月度好友：${data.monthlyTopFriends.slice(0, 6).map(m => `${m.month}月${m.displayName}`).join('、')}`)
  }

  return lines.join('\n')
}

/**
 * 叙事化年度报告 Prompt —— 输出结构化 Markdown
 */
export function buildNarrationPrompt(data: AnnualReportData): string {
  const context = buildReportContext(data)
  return `你是一位温柔、细腻、擅长从数据中提炼情感的叙事作家。请根据下面的微信聊天年度统计数据，为用户写一份叙事化的"年度回顾"。

【要求】
1. 输出格式为 Markdown，包含一个诗意的二级标题和 6-8 段正文
2. 每段聚焦一个主题：如"核心好友"、"最高峰那一天"、"深夜时光"、"渐行渐远"、"话语的痕迹"等
3. 每段 2-4 句话，语言温暖、感性、具体；避免说教，避免空洞，避免"你真是一个…的人"这种扁平总结
4. 多用具体数字、具体日期、具体人名，让叙事落地
5. 如果数据显示某位好友消失/减少，请温柔地写，不要煽情过度
6. 结尾一段做一个诗意的总结，不超过 60 字
7. 不要出现"根据数据"、"统计显示"等工具感用词
8. 不要给建议，只做叙事

【数据】
${context}

请现在开始写，直接输出 Markdown 正文，不要寒暄。`
}

/**
 * 个性化标题生成 Prompt —— 输出严格 JSON
 */
export function buildTitlePrompt(data: AnnualReportData): string {
  const context = buildReportContext(data)
  return `请根据下面的微信年度聊天数据，为用户生成一个诗意的年度标题。

【要求】
- 输出严格 JSON，只包含两个字段：{"title": "...", "subtitle": "..."}
- title：6-10 字，诗意、有画面感，能概括这一年的聊天氛围（示例：并肩而行的一年 / 话语编织的日子 / 深夜共灯的时光）
- subtitle：10-18 字，对 title 做一个具体化补充，可提 top 好友或关键事件
- 不要用"的一年"这类套话作为唯一修饰
- 只输出 JSON，不要任何多余的解释或代码块标记

【数据】
${context}`
}

/**
 * 从 LLM 返回的标题 JSON 里提取 title/subtitle
 */
export function parseTitleJson(text: string): { title?: string; subtitle?: string } {
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  try {
    const parsed = JSON.parse(cleaned)
    return {
      title: typeof parsed?.title === 'string' ? parsed.title : undefined,
      subtitle: typeof parsed?.subtitle === 'string' ? parsed.subtitle : undefined
    }
  } catch {
    // 兜底：如果返回的不是严格 JSON，尝试正则
    const titleMatch = cleaned.match(/"title"\s*:\s*"([^"]+)"/)
    const subtitleMatch = cleaned.match(/"subtitle"\s*:\s*"([^"]+)"/)
    return {
      title: titleMatch?.[1],
      subtitle: subtitleMatch?.[1]
    }
  }
}
