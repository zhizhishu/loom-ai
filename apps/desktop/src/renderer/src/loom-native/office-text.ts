const OFFICE_DOCUMENT = /\.(docx|pptx|xlsx)$/iu
export const OFFICE_EXTRACT_MAX_CHARS = 200_000

export function isOfficeDocumentName(name: string): boolean {
  return OFFICE_DOCUMENT.test(name)
}

/** Extracts assistant-readable text in the browser before the bytes leave the device. */
export async function extractOfficeDocumentText(file: File): Promise<string | undefined> {
  if (!isOfficeDocumentName(file.name)) return undefined
  const { parseOffice } = await import('officeparser')
  const ast = await parseOffice(file, { includeRawContent: false, extractAttachments: false, ocr: false })
  const output = await ast.to('text')
  const text = typeof output.value === 'string' ? output.value : String(output.value ?? '')
  return text.slice(0, OFFICE_EXTRACT_MAX_CHARS)
}
