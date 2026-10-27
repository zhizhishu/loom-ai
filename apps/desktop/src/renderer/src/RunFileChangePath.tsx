import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import { agentRunFilePathParts } from './file-changes-presentation'

export function RunFileChangePath({ path }: { path: string }): JSX.Element {
  const normalized = path.replaceAll('\\', '/')
  const { basename } = agentRunFilePathParts(normalized)
  const prefix = normalized.slice(0, normalized.length - basename.length)
  const directory = prefix === './' ? '' : prefix
  const [visibleDirectory, setVisibleDirectory] = useState(directory)
  const codeRef = useRef<HTMLElement>(null)
  const directoryRef = useRef<HTMLSpanElement>(null)
  const basenameRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const code = codeRef.current
    const directoryElement = directoryRef.current
    const basenameElement = basenameRef.current
    const context = document.createElement('canvas').getContext('2d')
    if (!code || !directoryElement || !basenameElement || !context) return

    const fitDirectory = (): void => {
      context.font = getComputedStyle(basenameElement).font
      const available = Math.max(0, code.clientWidth - context.measureText(basename).width)
      context.font = getComputedStyle(directoryElement).font
      if (context.measureText(directory).width <= available) {
        setVisibleDirectory(directory)
        return
      }
      // Remove directory segments from the right while keeping the filename intact.
      let end = directory.lastIndexOf('/', directory.length - 2)
      while (end >= 0) {
        const candidate = `${directory.slice(0, end + 1)}.../`
        if (context.measureText(candidate).width <= available) {
          setVisibleDirectory(candidate)
          return
        }
        end = end > 0 ? directory.lastIndexOf('/', end - 1) : -1
      }
      setVisibleDirectory(context.measureText('.../').width <= available ? '.../' : '')
    }
    fitDirectory()
    const observer = new ResizeObserver(fitDirectory)
    observer.observe(code)
    return () => observer.disconnect()
  }, [basename, directory])

  return (
    <code ref={codeRef} title={path}>
      <span ref={directoryRef} className="run-file-change-directory">{visibleDirectory}</span>
      <span ref={basenameRef} className="run-file-change-basename">{basename}</span>
    </code>
  )
}
