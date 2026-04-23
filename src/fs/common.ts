import type { FileChangeType, TextDocument, TextEditorEdit, Uri } from 'vscode'
import { ref, useDisposable } from 'reactive-vscode'
import { FileSystemError, Range, window, workspace, WorkspaceEdit } from 'vscode'
import * as Y from 'yjs'

export type FilesMap = Y.Map<Y.Doc>
export interface TrackContentRequest { guestId: string, uri: string, content?: string }
export interface FileChangeEvent { uri: string, type: FileChangeType }

const editingUris = new Map<string, number>()
const pendingTextDocumentUpdates = new Map<string, Promise<void>>()
const hostUriToTrackUri = new Map<string, string>()
const trackedDocs = new Map<string, Y.Doc>()
export const hostTrackedUrisVersion = ref(0)
export const trackedDocsVersion = ref(0)
const localEditOrigin = Symbol('together-code-local-edit')
const systemSyncOrigin = Symbol('together-code-system-sync')

// Registry of Y.js UndoManagers keyed by the VSCode document URI string.
// The undo/redo commands look up this map to decide whether to use Y.js undo
// or fall back to VSCode's native undo.
export const undoManagers = new Map<string, Y.UndoManager>()

export function createCollaborativeUndoManager(text: Y.Text) {
  return new Y.UndoManager(text, {
    trackedOrigins: new Set([localEditOrigin]),
  })
}

export function registerUndoManager(uri: string, manager: Y.UndoManager) {
  undoManagers.set(uri, manager)
}

export function unregisterUndoManager(uri: string) {
  undoManagers.delete(uri)
}

export function registerHostTrackedUri(hostUri: Uri | string, trackUri: Uri | string) {
  const hostUriString = hostUri.toString()
  const trackUriString = trackUri.toString()
  if (hostUriToTrackUri.get(hostUriString) !== trackUriString) {
    hostUriToTrackUri.set(hostUriString, trackUriString)
    hostTrackedUrisVersion.value++
  }
}

export function unregisterHostTrackedUri(hostUri: Uri | string) {
  if (hostUriToTrackUri.delete(hostUri.toString())) {
    hostTrackedUrisVersion.value++
  }
}

export function getHostTrackedUri(hostUri: Uri | string) {
  return hostUriToTrackUri.get(hostUri.toString())
}

export function registerTrackedDoc(uri: Uri | string, doc: Y.Doc) {
  const key = uri.toString()
  if (trackedDocs.get(key) !== doc) {
    trackedDocs.set(key, doc)
    trackedDocsVersion.value++
  }
}

export function unregisterTrackedDoc(uri: Uri | string, doc?: Y.Doc) {
  const key = uri.toString()
  const trackedDoc = trackedDocs.get(key)
  if (trackedDoc && (!doc || trackedDoc === doc)) {
    trackedDocs.delete(key)
    trackedDocsVersion.value++
  }
}

export function getTrackedDoc(uri: Uri | string) {
  return trackedDocs.get(uri.toString())
}

export function transactSystemChange(doc: Y.Doc, fn: () => void) {
  doc.transact(fn, systemSyncOrigin)
}

export function useTextDocumentWatcher(getDoc: (document: TextDocument) => Y.Doc | null | undefined) {
  useDisposable(workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
    if (contentChanges.length === 0 || editingUris.has(document.uri.toString())) {
      return
    }

    const doc = getDoc(document)
    if (!doc) {
      return
    }

    // Mark editor-originated changes explicitly so collaborative undo only
    // tracks the active user's own edits.
    doc.transact(() => {
      const text = doc.getText()
      const sortedChanges = contentChanges.slice().sort((a, b) => b.rangeOffset - a.rangeOffset)
      for (const change of sortedChanges) {
        text.delete(change.rangeOffset, change.rangeLength)
        text.insert(change.rangeOffset, change.text)
      }
    }, localEditOrigin)
  }))
}

export function setupTextDocumentUpdater(uri_: Uri, doc: Y.Doc, undoManager?: Y.UndoManager) {
  if (undoManager) {
    registerUndoManager(uri_.toString(), undoManager)
  }

  doc.getText().observe((event) => {
    // Skip local user edits — they already came from the editor, no need to
    // write them back. UndoManager transactions are also local but must be
    // applied so the editor reflects the undo/redo result.
    if (event.transaction.local && !isUndoManagerOrigin(event.transaction.origin))
      return

    const key = uri_.toString()
    const promise = applyTextDocumentDelta(uri_, event.delta)
      .catch((error) => {
        console.error('Failed to apply text document update:', error)
      })
      .finally(() => {
        if (pendingTextDocumentUpdates.get(key) === promise) {
          pendingTextDocumentUpdates.delete(key)
        }
      })
    pendingTextDocumentUpdates.set(key, promise)
  })
}

export async function waitForTextDocumentUpdates(uri: Uri | string) {
  const key = uri.toString()
  while (true) {
    const pending = pendingTextDocumentUpdates.get(key)
    if (!pending) {
      return
    }
    await pending
  }
}

function isUndoManagerOrigin(origin: any): boolean {
  // Y.UndoManager sets itself as the transaction origin when executing undo/redo.
  // Detect this by checking for the characteristic properties of UndoManager.
  return origin !== null
    && typeof origin === 'object'
    && typeof origin.undo === 'function'
    && typeof origin.redo === 'function'
    && 'undoStack' in origin
}

const applyTextDocumentDelta = createSequentialFunction(async (uri: Uri, delta: Y.YEvent<any>['delta']) => {
  try {
    editingUris.set(uri.toString(), (editingUris.get(uri.toString()) ?? 0) + 1)

    // Try updating via editor
    const editor = window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString())
    if (editor) {
      const applied = await editor.edit((edits) => {
        applyDeltaToEditBuilder(editor.document, delta, edits)
      }, {
        undoStopBefore: false,
        undoStopAfter: false,
      })
      if (applied) {
        return
      }
    }

    // Update with document
    // Should NOT use `workspace.fs.writeFile`, as the document may be unsaved
    const doc = await workspace.openTextDocument(uri)
    const edits = new WorkspaceEdit()
    applyDeltaToWorkspaceEdit(uri, doc, delta, edits)
    await workspace.applyEdit(edits)
  }
  finally {
    const count = (editingUris.get(uri.toString()) ?? 1) - 1
    if (count <= 0)
      editingUris.delete(uri.toString())
    else
      editingUris.set(uri.toString(), count)
  }
})

function applyDeltaToEditBuilder(
  doc: TextDocument,
  delta: Y.YEvent<any>['delta'],
  edits: TextEditorEdit,
) {
  let index = 0
  for (const d of delta) {
    if (d.retain) {
      index += d.retain
    }
    else if (d.insert) {
      const insert = d.insert as string
      edits.insert(doc.positionAt(index), insert)
    }
    else if (d.delete) {
      edits.delete(new Range(
        doc.positionAt(index),
        doc.positionAt(index + d.delete),
      ))
      index += d.delete
    }
  }
}

function applyDeltaToWorkspaceEdit(
  uri: Uri,
  doc: TextDocument,
  delta: Y.YEvent<any>['delta'],
  edits: WorkspaceEdit,
) {
  let index = 0
  for (const d of delta) {
    if (d.retain) {
      index += d.retain
    }
    else if (d.insert) {
      const insert = d.insert as string
      edits.insert(uri, doc.positionAt(index), insert)
    }
    else if (d.delete) {
      edits.delete(uri, new Range(
        doc.positionAt(index),
        doc.positionAt(index + d.delete),
      ))
      index += d.delete
    }
  }
}

function createSequentialFunction<T extends (...args: any[]) => Promise<any>>(fn: T): T {
  let lastPromise: Promise<any> = Promise.resolve()
  return ((...args) => lastPromise = lastPromise.then(() => fn(...args))) as T
}

export function forceUpdateContent(uri: Uri | string, doc: Y.Doc, content: Uint8Array) {
  const newText = new TextDecoder().decode(content)
  const oldText = doc.getText().toString()
  if (oldText !== newText) {
    transactSystemChange(doc, () => {
      const text = doc.getText()
      text.delete(0, text.length)
      text.insert(0, newText)
    })
    console.warn('External edit to', uri.toString())
  }
}

interface FsResult<T> { ok?: T, err?: string }

export function fsErrorWrapper<A extends any[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<FsResult<R>> {
  return async (...args) => {
    try {
      return { ok: await fn(...args) }
    }
    catch (e) {
      if (e instanceof FileSystemError)
        return { err: e.code }
      throw e
    }
  }
}

export function handleFsError<T>(result: FsResult<T>): T {
  if (result.err) {
    const factory = FileSystemError[result.err as keyof typeof FileSystemError] as any
    if (typeof factory !== 'function')
      throw new Error(`Unknown FileSystemError code: ${result.err}`)
    throw factory()
  }
  return result.ok!
}
