import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $addUpdateTag, $getRoot, $getSelection, $isElementNode, $isRangeSelection, $onUpdate,
  COMMAND_PRIORITY_NORMAL, HISTORIC_TAG, HISTORY_MERGE_TAG,
  KEY_ARROW_UP_COMMAND, KEY_ARROW_DOWN_COMMAND, KEY_ESCAPE_COMMAND,
  UNDO_COMMAND, REDO_COMMAND, mergeRegister, type EditorState, type LexicalCommand
} from 'lexical'
import { useEffect, useMemo, useRef, type RefObject } from 'react'
import type { ComposerDocument } from '@contracts'
import { $replaceEditorWithComposerDocument } from './composer-editor-state'
import { ComposerDraftSync, ROVAI_INPUT_HISTORY_PREVIEW_TAG } from './composer-draft-sync'
import { InputHistoryNavigation, isInputHistoryKey } from './input-history'

export type ComposerHistoryNavigation = InputHistoryNavigation<ComposerDocument, EditorState>

// Document boundaries are independent of wrapping, zoom and visual line height.
function $atDocumentBoundary(end: boolean): boolean {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false
  let node = selection.anchor.getNode()
  const length = $isElementNode(node) ? node.getChildrenSize() : node.getTextContentSize()
  if (selection.anchor.offset !== (end ? length : 0)) return false
  while (node.getKey() !== 'root') {
    if (end ? node.getNextSibling() : node.getPreviousSibling()) return false
    const parent = node.getParent()
    if (!parent) return false
    node = parent
  }
  return true
}

export function ComposerInputHistoryPlugin({ getHistory, syncRef, navigationRef }: {
  getHistory(): ComposerDocument[]
  syncRef: RefObject<ComposerDraftSync | null>
  navigationRef: RefObject<ComposerHistoryNavigation | null>
}): null {
  const [editor] = useLexicalComposerContext()
  const source = useRef(getHistory)
  source.current = getHistory
  const navigation = useMemo(() => new InputHistoryNavigation(() => source.current(), {
    capture: () => editor.getEditorState(),
    preview(content, boundary) {
      editor.update(() => {
        $replaceEditorWithComposerDocument(content)
        if (boundary === 'start') $getRoot().selectStart()
        else $getRoot().selectEnd()
      }, { discrete: true, tag: [ROVAI_INPUT_HISTORY_PREVIEW_TAG, HISTORIC_TAG] })
    },
    restore(snapshot) {
      editor.update(() => {
        editor.setEditorState(snapshot, { tag: ROVAI_INPUT_HISTORY_PREVIEW_TAG })
        // Browsing/caret moves must not add recalled content to the undo stack.
        $addUpdateTag(HISTORY_MERGE_TAG)
      }, { discrete: true })
      syncRef.current?.restoreHistoryDraft()
    }
  }), [editor, syncRef])

  useEffect(() => {
    navigationRef.current = navigation
    const handle = (event: KeyboardEvent): boolean => {
      if (!editor.isEditable() || editor.isComposing() || !isInputHistoryKey(event)) return false
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false
      let handled: boolean
      if (event.key === 'Escape') handled = navigation.cancel()
      else {
        const older = event.key === 'ArrowUp'
        if (!$atDocumentBoundary(!older)) return false
        handled = older ? navigation.older() : navigation.newer()
      }
      if (!handled) return false
      event.preventDefault()
      return true
    }
    const restoreBeforeHistoryCommand = (command: LexicalCommand<void>): boolean => {
      if (!navigation.cancel()) return false
      // Caret-only changes can merge the preview into Lexical's current history
      // entry. Restore and commit the real draft before forwarding the command;
      // nested editor.update() calls have not committed when cancel() returns.
      $onUpdate(() => editor.dispatchCommand(command, undefined))
      return true
    }
    const unregister = mergeRegister(
      editor.registerCommand(KEY_ARROW_UP_COMMAND, handle, COMMAND_PRIORITY_NORMAL),
      editor.registerCommand(KEY_ARROW_DOWN_COMMAND, handle, COMMAND_PRIORITY_NORMAL),
      editor.registerCommand(KEY_ESCAPE_COMMAND, handle, COMMAND_PRIORITY_NORMAL),
      editor.registerCommand(UNDO_COMMAND, () => restoreBeforeHistoryCommand(UNDO_COMMAND), COMMAND_PRIORITY_NORMAL),
      editor.registerCommand(REDO_COMMAND, () => restoreBeforeHistoryCommand(REDO_COMMAND), COMMAND_PRIORITY_NORMAL)
    )
    return () => {
      unregister()
      navigation.adopt()
      if (navigationRef.current === navigation) navigationRef.current = null
    }
  }, [editor, navigation, navigationRef])
  return null
}
