import { useMobileLayout } from './MobileLayout'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type SetStateAction
} from 'react'
import { UiText, uiAttribute } from './interface-language'
import { splitterScale, useCollapsibleSplitter } from './useCollapsibleSplitter'
import { SplitterFeedback } from './SplitterFeedback'

const STORAGE_KEY = 'rovai-member-roster-width-v2'
const LEGACY_STORAGE_KEY = 'rovai-member-roster-width-v1'
const DEFAULT_WIDTH = 256
const MIN_WIDTH = 192
const MAX_WIDTH = 360
const COLLAPSED_WIDTH = 76
const EXPAND_THRESHOLD = 208
const MIN_EDITOR_WIDTH = 400

interface RosterPreference {
  width: number
  collapsed: boolean
}

interface RosterControls {
  id: string
  preference: RosterPreference
  width: number
  maxWidth: number
  collapsed: boolean
  sorting: boolean
  setSorting: Dispatch<SetStateAction<boolean>>
  setCollapsed(value: boolean): void
  setWidth(value: number, expand?: boolean): void
  restorePreference(preference: RosterPreference): void
  setHeldFold(value: boolean): void
}

const RosterContext = createContext<RosterControls | null>(null)

export function useMemberRosterLayout(): RosterControls {
  const value = useContext(RosterContext)
  if (!value) throw new Error('Member roster must be inside MemberRosterLayout')
  return value
}

function initialPreference(): RosterPreference {
  const fallback = { width: DEFAULT_WIDTH, collapsed: false }
  if (typeof window === 'undefined') return fallback
  try {
    fallback.collapsed = window.localStorage.getItem(LEGACY_STORAGE_KEY) === 'collapsed'
    const stored: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (!stored || typeof stored !== 'object') return fallback
    const { width, collapsed } = stored as Partial<RosterPreference>
    return {
      width: typeof width === 'number' && Number.isFinite(width)
        ? Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width)))
        : DEFAULT_WIDTH,
      collapsed: typeof collapsed === 'boolean' ? collapsed : fallback.collapsed
    }
  } catch {
    return fallback
  }
}

export function MemberRosterLayout({ children, separatorLabel = uiAttribute('队员列表宽度') }: { children: ReactNode; separatorLabel?: string }): React.JSX.Element {
  const mobile = useMobileLayout()
  const [preference, setPreference] = useState(initialPreference)
  const [maxWidth, setMaxWidth] = useState(MAX_WIDTH)
  const [sorting, setSorting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [heldFold, setHeldFold] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)
  const id = `member-roster-${useId()}`
  const width = Math.min(preference.width, maxWidth)

  useEffect(() => {
    if (dragging) return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preference))
    } catch {
      // Width and collapse are optional local presentation preferences.
    }
  }, [preference, dragging])

  useEffect(() => {
    const workspace = shellRef.current?.parentElement
    if (!workspace) return
    const measure = (): void => {
      setMaxWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, workspace.clientWidth - MIN_EDITOR_WIDTH)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(workspace)
    return () => observer.disconnect()
  }, [])

  const setCollapsed = useCallback((collapsed: boolean): void => {
    setPreference((current) => current.collapsed === collapsed ? current : { ...current, collapsed })
  }, [])
  const setWidth = useCallback((value: number, expand = true): void => {
    const next = Math.round(Math.max(MIN_WIDTH, Math.min(maxWidth, value)))
    setPreference((current) => {
      const collapsed = expand ? false : current.collapsed
      return current.width === next && current.collapsed === collapsed
        ? current
        : { width: next, collapsed }
    })
  }, [maxWidth])

  return (
    <RosterContext.Provider value={{ id, preference, width, maxWidth, collapsed: !mobile && (heldFold || preference.collapsed), setHeldFold, sorting, setSorting, setCollapsed, setWidth, restorePreference: setPreference }}>
      <div
        ref={shellRef}
        className={`member-editor-roster-shell ${dragging ? 'is-resizing' : ''}`}
        style={{ '--member-roster-width': `${(heldFold || preference.collapsed) ? COLLAPSED_WIDTH : width}px` } as CSSProperties}
      >
        {children}
        <MemberRosterSeparator dragging={dragging} setDragging={setDragging} label={separatorLabel} />
      </div>
    </RosterContext.Provider>
  )
}

function MemberRosterSeparator({ dragging, setDragging, label }: {
  dragging: boolean
  setDragging(value: boolean): void
  label: string
}): React.JSX.Element {
  const { id, preference, width, maxWidth, collapsed, sorting, setCollapsed, setWidth, restorePreference, setHeldFold } = useMemberRosterLayout()
  const handleRef = useRef<HTMLDivElement>(null)
  const shell = (): HTMLElement | null => handleRef.current?.closest('.member-editor-roster-shell') ?? null
  const paintWidth = (value: number): void => shell()?.style.setProperty('--member-roster-width', `${value}px`)
  const previewWidth = (value: number): void => { paintWidth(value); setWidth(value) }
  const splitter = useCollapsibleSplitter({
    size: collapsed ? COLLAPSED_WIDTH : width, collapsed, minimum: MIN_WIDTH, maximum: maxWidth,
    collapsedSize: COLLAPSED_WIDTH, expandAt: EXPAND_THRESHOLD, direction: 1, disabled: sorting,
    scale: () => splitterScale(shell()),
    capture: () => preference,
    onPreview: previewWidth,
    onCommit: previewWidth,
    onCollapseFrame: paintWidth,
    onFoldPreview: edge => setHeldFold(edge === 'minimum'),
    onCollapse: before => { paintWidth(COLLAPSED_WIDTH); restorePreference({ ...before, collapsed: true }) },
    onCancel: before => { paintWidth(before.collapsed ? COLLAPSED_WIDTH : Math.min(maxWidth, before.width)); restorePreference(before) },
    onActiveChange: setDragging
  })
  const helpId = `${id}-resize-help`

  return (
    <div
      ref={handleRef}
      className={`member-roster-resizer ${dragging ? 'is-dragging' : ''}`}
      role="separator"
      tabIndex={sorting ? -1 : 0}
      aria-label={label}
      aria-disabled={sorting || undefined}
      aria-orientation="vertical"
      aria-valuemin={COLLAPSED_WIDTH}
      aria-valuemax={maxWidth}
      aria-valuenow={collapsed ? COLLAPSED_WIDTH : width}
      aria-valuetext={collapsed ? uiAttribute("已折叠，按右方向键展开") : uiAttribute("{0} 像素", String(width))}
      aria-controls={id}
      aria-describedby={helpId}
      title={collapsed ? uiAttribute("向右拖动展开；双击恢复默认") : uiAttribute("拖动调整宽度，最窄处继续向左内推直接收起；双击恢复默认")}
      {...splitter.handlers}
      onDoubleClick={() => { if (!sorting) { splitter.cancel(); setWidth(DEFAULT_WIDTH) } }}
      onKeyDown={(event) => {
        if (sorting || splitter.active) return
        if (event.key === 'Enter' || (event.key === 'ArrowLeft' && (collapsed || width <= MIN_WIDTH))) {
          event.preventDefault()
          setCollapsed(event.key === 'Enter' ? !collapsed : true)
          return
        }
        if (event.key === 'ArrowRight' && collapsed) {
          event.preventDefault()
          setCollapsed(false)
          return
        }
        const next = event.key === 'ArrowLeft' ? width - 16
          : event.key === 'ArrowRight' ? width + 16
          : event.key === 'Home' ? DEFAULT_WIDTH
          : event.key === 'End' ? maxWidth : null
        if (next === null) return
        event.preventDefault()
        setWidth(next)
      }}
    >
      <SplitterFeedback phase={splitter.phase} target={splitter.target} label={uiAttribute('继续拖动收起名册')} />
      {splitter.phase !== 'detent' && <span className="member-roster-resize-hint" aria-hidden="true">{collapsed ? uiAttribute("已折叠") : `${width} px`}</span>}
      <span id={helpId} className="member-roster-sr-only"><UiText zh={"左右方向键调整；最窄时按左方向键折叠，右方向键展开，回车切换折叠，Home 恢复默认；Escape 取消拖动。"} /></span>
    </div>
  )
}
