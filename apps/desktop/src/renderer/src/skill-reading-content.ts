export function skillReadingContent(content: string): string {
  return content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '')
}
