const OFFICE_DOCUMENT = /\.(docx|pptx|xlsx|xls|odt|ods|odp|rtf)$/iu
export const OFFICE_EXTRACT_MAX_BYTES = 25 * 1024 * 1024
export const OFFICE_EXTRACT_MAX_CHARS = 200_000

export class OfficeExtractError extends Error {
  constructor(readonly code: 'tooLarge' | 'tooLong' | 'unreadable') {
    super(code)
  }
}

export function isOfficeDocumentName(name: string): boolean {
  return OFFICE_DOCUMENT.test(name)
}

function officeExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

/** Extracts assistant-readable text in the browser before the bytes leave the device. */
export async function extractOfficeDocumentText(file: File): Promise<string | undefined> {
  if (!isOfficeDocumentName(file.name)) return undefined
  if (file.size > OFFICE_EXTRACT_MAX_BYTES) throw new OfficeExtractError('tooLarge')
  const data = new Uint8Array(await file.arrayBuffer())
  if (!data.length) throw new OfficeExtractError('unreadable')
  const ext = officeExtension(file.name)
  try {
    let text: string
    if (ext === 'xls') {
      const xlsx = await import('@e965/xlsx')
      const book = xlsx.read(data, { type: 'array', cellDates: true })
      text = book.SheetNames.map(sheet => `# ${sheet}\n${xlsx.utils.sheet_to_csv(book.Sheets[sheet])}`).join('\n\n')
    } else {
      const { OfficeParser } = await import('officeparser')
      const doc = await OfficeParser.parseOffice(data, {
        fileType: ext as 'docx',
        extractAttachments: false,
        includeRawContent: false,
        ocr: false,
        decompressionLimits: { maxUncompressedBytes: 64 * 1024 * 1024, maxZipEntries: 5000 },
      })
      if (doc.warnings.some(warning => /LIMIT|TRUNCATED/.test(warning.code))) throw new OfficeExtractError('tooLong')
      if (ext === 'xlsx' || ext === 'ods') {
        const sheets = [...doc.content]
        const rendered: string[] = []
        for (const sheet of sheets) {
          doc.content = [sheet]
          const output = await doc.to('md', { includeImages: 'none' })
          rendered.push(`# ${sheet.type === 'sheet' ? sheet.metadata?.sheetName ?? 'Sheet' : 'Sheet'}\n${output.value}`)
        }
        text = rendered.join('\n\n')
      } else {
        const output = await doc.to('md', { includeImages: 'none' })
        text = typeof output.value === 'string' ? output.value : String(output.value ?? '')
      }
    }
    if (text.length > OFFICE_EXTRACT_MAX_CHARS) throw new OfficeExtractError('tooLong')
    if (!text.trim()) throw new OfficeExtractError('unreadable')
    return text.trim()
  } catch (error) {
    if (error instanceof OfficeExtractError) throw error
    throw new OfficeExtractError('unreadable')
  }
}
