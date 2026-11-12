// ============================================================
// Markdown (what LLMs write) → WhatsApp formatting (what customers see).
//   **bold** / __bold__ → *bold*     ~~strike~~ → ~strike~
//   # Heading           → *Heading*  [text](url) → text: url
//   * item / + item     → • item     (a leading "*" would read as bold)
// Code fences / `inline code` are left alone (WhatsApp renders ``` too).
// ============================================================

export function toWhatsAppFormat(text: string): string {
  if (!text) return text;
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part) => {
      if (part.startsWith('```')) return part;
      return part
        .replace(/\*\*\*(.+?)\*\*\*/g, '*_$1_*')
        .replace(/\*\*(.+?)\*\*/g, '*$1*')
        .replace(/__(.+?)__/g, '*$1*')
        .replace(/~~(.+?)~~/g, '~$1~')
        .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '*$1*')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) =>
          label.trim() === url ? url : `${label.trim()}: ${url}`
        )
        .replace(/^([ \t]*)[*+][ \t]+/gm, '$1• ')
        .replace(/\*{2,}/g, '*');
    })
    .join('');
}
