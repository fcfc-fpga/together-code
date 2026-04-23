import type { ComputedRef, Ref } from 'reactive-vscode'
import type { DecorationOptions, TextDocument, TextEditor, TextEditorDecorationType } from 'vscode'
import { computed, defineService, onScopeDispose, ref, shallowRef, useCommands, useDisposable, useVisibleTextEditors, watch, watchEffect } from 'reactive-vscode'
import { DecorationRangeBehavior, OverviewRulerLane, Selection, TextEditorRevealType, Uri, window, workspace } from 'vscode'
import * as Y from 'yjs'
import { getHostTrackedUri, getTrackedDoc, hostTrackedUrisVersion, trackedDocsVersion } from '../fs/common'
import { ensureGuestTrackedContent } from '../fs/guest'
import { ensureHostTrackedContent } from '../fs/host'
import { CustomUriScheme } from '../fs/provider'
import { useActiveSession } from '../session'
import { useShallowYMapKeyScopes } from '../sync/doc'
import { withOpacity } from './colors'
import { useUsers } from './users'

type AbsoluteSelection = ConstructorParameters<typeof Selection>
type RelativeSelection = [number[], number[]]

interface SelectionInfo {
  uri: string
  selections: RelativeSelection[]
  fallbackSelections: AbsoluteSelection[]
}

export const useSelections = defineService(() => {
  const { doc, role, selfId, toTrackUri, toLocalUri } = useActiveSession()
  const { getUserInfo } = useUsers()

  const map = computed(() => doc.value?.getMap<SelectionInfo>('selections'))
  const textDocumentVersion = useTextDocumentVersion()

  const selfRealtimeSelections = useRealtimeSelections()
  const { documentVersion, editor, selections: selfSelections } = selfRealtimeSelections
  watch([map, role, selfId, editor, selfSelections, documentVersion, hostTrackedUrisVersion, trackedDocsVersion], () => {
    if (map.value && selfId.value) {
      const activeEditor = editor.value
      const clientUri = activeEditor && getTrackUri(activeEditor.document.uri)
      if (clientUri) {
        const trackedDoc = getTrackedDoc(clientUri)
        if (!trackedDoc && activeEditor) {
          void ensureSelectionTrackedContent(role.value, activeEditor.document.uri)
        }
        const info: SelectionInfo = {
          uri: clientUri.toString(),
          selections: trackedDoc
            ? selfSelections.value.map(selection => encodeSelection(trackedDoc, activeEditor!.document, selection))
            : [],
          fallbackSelections: selfSelections.value.map(selection => selectionToTuple(selection)),
        }
        map.value.set(selfId.value, info)
      }
      else {
        map.value.delete(selfId.value)
      }
    }
  }, { immediate: true })
  onScopeDispose(() => {
    if (map.value && selfId.value) {
      map.value.delete(selfId.value)
    }
  })

  function getTrackUri(uri: Uri) {
    const tracked = getHostTrackedUri(uri)
    return tracked ? Uri.parse(tracked) : toTrackUri(uri)
  }

  const visibleTextEditors = useVisibleTextEditors()
  const mapVersion = useShallowYMapKeyScopes(map, (peerId, info) => {
    if (peerId === selfId.value) {
      return
    }

    const uri = computed(() => toLocalUri(Uri.parse(info.value.uri)))
    const editor = computed(() => visibleTextEditors.value.find(e => e.document.uri.toString() === uri.value.toString()))
    const selections = computed(() => {
      void textDocumentVersion.value
      void trackedDocsVersion.value
      return editor.value
        ? resolveSelectionInfo(info.value, editor.value.document)
        : info.value.fallbackSelections
    })
    const color = computed(() => getUserInfo(peerId).color)

    // Selection decorations
    const selectionType = shallowRef<TextEditorDecorationType>(null!)
    watchEffect((onCleanup) => {
      const type = selectionType.value = window.createTextEditorDecorationType({
        backgroundColor: withOpacity(color.value.bg, 0.35),
        borderRadius: '0.1rem',
        isWholeLine: false,
        rangeBehavior: DecorationRangeBehavior.ClosedOpen,
        overviewRulerLane: OverviewRulerLane.Full,
      })
      onCleanup(() => type.dispose())
    })
    watchEffect((onCleanup) => {
      const e = editor.value
      if (!e) {
        return
      }
      const { color } = getUserInfo(peerId)
      e.setDecorations(selectionType.value, selections.value.map((s) => {
        const range = new Selection(...s)
        return {
          range,
          renderOptions: {
            [range.isReversed ? 'before' : 'after']: {
              contentText: 'ᛙ',
              margin: `0px 0px 0px -${range.active.character === 0 ? '0.17' : '0.25'}ch`,
              color: color.bg,
              textDecoration: `none; ${stringifyCssProperties({
                'position': 'absolute',
                'display': 'inline-block',
                'top': '0',
                'font-size': '200%',
                'font-weight': 'bold',
                'z-index': 1,
              })}`,
            },
          },
        } satisfies DecorationOptions
      }))
      onCleanup(() => {
        if (e !== editor.value) {
          e.setDecorations(selectionType.value, [])
        }
      })
    })

    // Name tag decorations
    const nameTagType = shallowRef<TextEditorDecorationType>(null!)
    watchEffect((onCleanup) => {
      const type = nameTagType.value = window.createTextEditorDecorationType({
        backgroundColor: color.value.bg,
        rangeBehavior: DecorationRangeBehavior.ClosedClosed,
        textDecoration: 'none; position: relative; z-index: 1;',
      })
      onCleanup(() => type.dispose())
    })
    const activePosition = computed(() => {
      const selection = selections.value[selections.value.length - 1]
      return selection ? new Selection(...selection).active : null
    })
    const isFirstLine = computed(() => activePosition.value?.line === 0)
    const isSameEditor = computed(() => editor.value && editor.value === selfRealtimeSelections.editor.value)
    const isEditingAbove = computed(() => {
      const position = activePosition.value
      return !!position && isSameEditor.value && selfRealtimeSelections.selections.value.some(s => s.active.line === position.line - 1)
    })
    const isEditingBelow = computed(() => {
      const position = activePosition.value
      return !!position && isSameEditor.value && selfRealtimeSelections.selections.value.some(s => s.active.line === position.line + 1)
    })
    const hideNameTag = computed(() => isFirstLine.value && isEditingBelow.value)
    const belowText = computed(() => isFirstLine.value || isEditingAbove.value)
    watchEffect((onCleanup) => {
      const e = editor.value
      const position = activePosition.value
      if (!e || !position || selections.value.length === 0) {
        return
      }
      if (hideNameTag.value) {
        e.setDecorations(nameTagType.value, [])
        return
      }
      const { name, color } = getUserInfo(peerId)
      e.setDecorations(nameTagType.value, [{
        range: new Selection(position, position),
        renderOptions: {
          before: {
            contentText: name,
            backgroundColor: color.bg,
            textDecoration: `none; ${stringifyCssProperties({
              'position': 'absolute',
              'top': `calc(${belowText.value ? 1 : -1} * var(--vscode-editorCodeLens-lineHeight))`,
              'border-radius': '0.15rem',
              'padding': '0px 0.5ch',
              'display': 'inline-block',
              'pointer-events': 'none',
              'color': color.fg,
              'font-size': '0.7rem',
              'z-index': 1,
              'font-weight': 'bold',
            })}`,
          },
        },
      }])
      onCleanup(() => {
        if (e !== editor.value) {
          e.setDecorations(nameTagType.value, [])
        }
      })
    })
  })

  return useParticipantJump(map, mapVersion)
})

function stringifyCssProperties(e: Record<string, string | number>) {
  return Object.keys(e)
    .map(t => `${t}: ${e[t]};`)
    .join(' ')
}

const useRealtimeSelections = defineService(() => {
  const editor = shallowRef<TextEditor | undefined>(window.activeTextEditor)
  const selections = shallowRef<readonly Selection[]>(editor.value?.selections ?? [])
  const documentVersion = ref(0)
  useDisposable(window.onDidChangeActiveTextEditor((e) => {
    editor.value = e
    selections.value = e?.selections ?? []
    documentVersion.value++
  }))
  useDisposable(window.onDidChangeTextEditorSelection((ev) => {
    editor.value = ev.textEditor
    selections.value = ev.selections
  }))
  useDisposable(workspace.onDidChangeTextDocument(({ document }) => {
    if (document.uri.toString() === editor.value?.document.uri.toString()) {
      documentVersion.value++
    }
  }))
  return { documentVersion, editor, selections }
})

function useParticipantJump(map: ComputedRef<Y.Map<SelectionInfo> | undefined>, mapVersion: Ref<number>) {
  function getSelection(peerId: string) {
    void mapVersion.value
    return map.value?.get(peerId)
  }

  const { role, toLocalUri } = useActiveSession()
  const { pickPeerId } = useUsers()

  async function gotoSelection(info: SelectionInfo) {
    const localUri = toLocalUri(Uri.parse(info.uri))
    if (localUri.scheme === CustomUriScheme) {
      await ensureGuestTrackedContent(localUri)
    }
    else if (role.value === 'host') {
      await ensureHostTrackedContent(localUri)
    }

    try {
      const document = await workspace.openTextDocument(localUri)
      const selection = resolveSelectionInfo(info, document).at(-1)
      const range = selection ? new Selection(...selection) : undefined
      const editor = await window.showTextDocument(document, {
        preserveFocus: false,
        preview: false,
        selection: range,
      })
      if (range) {
        editor.revealRange(range, TextEditorRevealType.Default)
      }
    }
    catch (error) {
      console.error('Failed to jump to selection:', error)
      window.showErrorMessage('无法打开该用户当前所在的文件。')
    }
  }

  function resolvePeerId(arg?: any): string | undefined {
    if (typeof arg === 'string') {
      return arg
    }
    if (!arg || typeof arg !== 'object') {
      return undefined
    }
    if (typeof arg.peerId === 'string') {
      return arg.peerId
    }
    if (typeof arg.treeItem?.peerId === 'string') {
      return arg.treeItem.peerId
    }
    return undefined
  }

  async function jumpToParticipant(arg?: any) {
    const peerId = resolvePeerId(arg) ?? await pickPeerId()
    if (!peerId) {
      return
    }
    const info = getSelection(peerId)
    if (!info) {
      window.showInformationMessage('找不到该用户的光标位置。')
      return
    }
    await gotoSelection(info)
  }

  useCommands({
    'together-code.focusParticipant': jumpToParticipant,
    'together-code.jumpToParticipant': jumpToParticipant,
  })

  return { getSelection }
}

function useTextDocumentVersion() {
  const version = ref(0)
  useDisposable(workspace.onDidChangeTextDocument(() => {
    version.value++
  }))
  return version
}

function selectionToTuple(selection: Selection): AbsoluteSelection {
  return [
    selection.anchor.line,
    selection.anchor.character,
    selection.active.line,
    selection.active.character,
  ]
}

function encodeSelection(doc: Y.Doc, document: TextDocument, selection: Selection): RelativeSelection {
  const text = doc.getText()
  return [
    encodeRelativePosition(text, document.offsetAt(selection.anchor)),
    encodeRelativePosition(text, document.offsetAt(selection.active)),
  ]
}

function encodeRelativePosition(text: Y.Text, index: number) {
  return [...Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, 0))]
}

function resolveSelectionInfo(info: SelectionInfo, document: TextDocument): AbsoluteSelection[] {
  const doc = getTrackedDoc(info.uri)
  if (!doc) {
    return info.fallbackSelections
  }
  const text = doc.getText()
  const selections = info.selections
    .map(selection => resolveSelection(doc, text, document, selection))
    .filter((selection): selection is AbsoluteSelection => !!selection)
  return selections.length > 0 ? selections : info.fallbackSelections
}

function resolveSelection(doc: Y.Doc, text: Y.Text, document: TextDocument, selection: RelativeSelection): AbsoluteSelection | null {
  const anchor = Y.createAbsolutePositionFromRelativePosition(
    Y.decodeRelativePosition(Uint8Array.from(selection[0])),
    doc,
    false,
  )
  const active = Y.createAbsolutePositionFromRelativePosition(
    Y.decodeRelativePosition(Uint8Array.from(selection[1])),
    doc,
    false,
  )
  if (!anchor || !active || anchor.type !== text || active.type !== text) {
    return null
  }
  const anchorPosition = document.positionAt(anchor.index)
  const activePosition = document.positionAt(active.index)
  return [
    anchorPosition.line,
    anchorPosition.character,
    activePosition.line,
    activePosition.character,
  ]
}

async function ensureSelectionTrackedContent(role: string | undefined, uri: Uri) {
  if (role === 'host') {
    await ensureHostTrackedContent(uri)
  }
  else if (uri.scheme === CustomUriScheme) {
    await ensureGuestTrackedContent(uri)
  }
}
