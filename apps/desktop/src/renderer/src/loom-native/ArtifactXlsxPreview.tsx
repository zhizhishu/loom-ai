import { useMemo, useState } from 'react'
import { read, utils } from '@e965/xlsx'

const MAX_ROWS = 100
const MAX_COLUMNS = 24

export function ArtifactXlsxPreview({ bytes, fileName }: { bytes: Uint8Array; fileName: string }) {
  const parsed = useMemo(() => {
    try {
      const workbook = read(bytes, { type: 'array', dense: true })
      return { workbook, error: null as string | null }
    } catch (error) {
      return { workbook: null, error: error instanceof Error ? error.message : '表格解析失败' }
    }
  }, [bytes])
  const [sheetIndex, setSheetIndex] = useState(0)
  if (parsed.error || !parsed.workbook) return <div className="ln-artifact-state" data-state="error">表格解析失败：{parsed.error}</div>
  const workbook = parsed.workbook
  const sheetName = workbook.SheetNames[Math.min(sheetIndex, workbook.SheetNames.length - 1)]
  const sheet = workbook.Sheets[sheetName]
  const rows = sheet ? (utils.sheet_to_json(sheet, { header: 1, raw: false, blankrows: false }) as unknown[][]) : []
  const visibleRows = rows.slice(0, MAX_ROWS)
  const columnCount = Math.min(Math.max(1, ...visibleRows.map(row => Array.isArray(row) ? row.length : 0)), MAX_COLUMNS)
  return <div className="ln-artifact-spreadsheet">
    <div className="ln-artifact-spreadsheet-toolbar">
      <span>{fileName} · {sheetName || '空工作簿'}</span>
      {workbook.SheetNames.length > 1 && <select aria-label="选择工作表" value={sheetIndex} onChange={event => setSheetIndex(Number(event.target.value))}>
        {workbook.SheetNames.map((name, index) => <option key={name} value={index}>{name}</option>)}
      </select>}
    </div>
    {visibleRows.length === 0
      ? <div className="ln-artifact-state">这个工作表没有可显示的单元格。</div>
      : <div className="ln-artifact-spreadsheet-scroll"><table>
          <tbody>{visibleRows.map((row, rowIndex) => <tr key={rowIndex}>
            {Array.from({ length: columnCount }, (_, columnIndex) => {
              const value = Array.isArray(row) ? row[columnIndex] : undefined
              return rowIndex === 0
                ? <th key={columnIndex}>{value == null ? '' : String(value)}</th>
                : <td key={columnIndex}>{value == null ? '' : String(value)}</td>
            })}
          </tr>)}</tbody>
        </table></div>}
    {(rows.length > MAX_ROWS || visibleRows.some(row => Array.isArray(row) && row.length > MAX_COLUMNS)) &&
      <p className="ln-artifact-image-hint">仅预览前 {MAX_ROWS} 行、{MAX_COLUMNS} 列。</p>}
  </div>
}
