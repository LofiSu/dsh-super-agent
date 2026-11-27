/** Feishu documents a 30 KB maximum for card/rich-text message content. */
export const FEISHU_CARD_CONTENT_LIMIT_BYTES = 30 * 1024

export interface FeishuCardRenderResult {
  content: string
  truncated: boolean
}

const TRUNCATION_MARKER = '\n\n---\n**内容已截断；完整记录：'
const CARD_TITLE = 'ds-agent · 助手 🌱'

/** Markdown structure supported by Feishu's lark_md card text element. */
export function hasFeishuMarkdownStructure(text: string): boolean {
  return /^\s{0,3}#{1,6}\s+\S/m.test(text)
    || /^\s*(?:[-*+]\s+|\d+[.)]\s+)\S/m.test(text)
    || /^\s*```/m.test(text)
}

function card(text: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: CARD_TITLE } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }],
  }
}

function serialize(text: string): string {
  return JSON.stringify(card(text))
}

function truncatedBody(prefix: string, marker: string): string {
  const openFence = (prefix.match(/^```/gm)?.length ?? 0) % 2 === 1
  return `${prefix}${openFence ? '\n```\n' : ''}${marker}`
}

/** Render a single-column classic Feishu card, preserving a leading body prefix. */
export function renderFeishuMarkdownCard(text: string, ticketId: string): FeishuCardRenderResult {
  const full = serialize(text)
  if (Buffer.byteLength(full, 'utf8') <= FEISHU_CARD_CONTENT_LIMIT_BYTES) {
    return { content: full, truncated: false }
  }

  const marker = `${TRUNCATION_MARKER}${ticketId}`
  const points = Array.from(text)
  let low = 0
  let high = points.length
  let best = serialize(marker)
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = serialize(truncatedBody(points.slice(0, middle).join(''), marker))
    if (Buffer.byteLength(candidate, 'utf8') <= FEISHU_CARD_CONTENT_LIMIT_BYTES) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return { content: best, truncated: true }
}
