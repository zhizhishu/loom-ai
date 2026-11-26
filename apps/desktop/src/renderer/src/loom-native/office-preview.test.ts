import { describe, expect, it } from 'vitest'
import * as XLSX from '@e965/xlsx'
import { extractOfficeDocumentText, isOfficeDocumentName } from './office-text'
import { artifactMediaKind, normalizeArtifactMediaType } from './artifact-service'

describe('office preview/extraction', () => {
  it('recognizes the supported office input types', () => {
    expect(isOfficeDocumentName('报告.docx')).toBe(true)
    expect(isOfficeDocumentName('slides.pptx')).toBe(true)
    expect(isOfficeDocumentName('table.xlsx')).toBe(true)
    expect(isOfficeDocumentName('notes.md')).toBe(false)
  })

  it('extracts xlsx text for assistants', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([['名称', '数量'], ['苹果', 3]])
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1')
    const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })
    const text = await extractOfficeDocumentText(new File([bytes], 'table.xlsx'))
    expect(text).toContain('名称')
    expect(text).toContain('苹果')
  })

  it('admits xlsx artifact media as spreadsheet preview', () => {
    const mediaType = normalizeArtifactMediaType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(mediaType).not.toBeNull()
    expect(artifactMediaKind(mediaType!)).toBe('spreadsheet')
  })
})
