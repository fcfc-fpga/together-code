import type { IDisposable } from 'node-pty'
import type { TextDocumentChangeReason } from 'vscode'
import type { Connection } from '../sync/connection'
import type { FileChangeEvent, TrackContentRequest } from './common'
import picomatch from 'picomatch'
import { useDisposable } from 'reactive-vscode'
import { Disposable, FileChangeType, FileType, RelativePattern, Uri, workspace } from 'vscode'
import * as Y from 'yjs'
import { createCollaborativeUndoManager, forceUpdateContent, fsErrorWrapper, getHostTrackedUri, registerHostTrackedUri, registerTrackedDoc, setupTextDocumentUpdater, transactSystemChange, unregisterHostTrackedUri, unregisterTrackedDoc, unregisterUndoManager, useTextDocumentWatcher, waitForTextDocumentUpdates } from './common'
import { CustomUriScheme } from './provider'

let ensureHostTrackedContent_: ((uri: string) => Promise<void>) | undefined

export async function ensureHostTrackedContent(uri: Uri | string) {
  await ensureHostTrackedContent_?.(uri.toString())
}

export function useHostFs(connection: Connection) {
  const { toHostUri, toTrackUri } = connection

  const files = new Map<string, {
    doc: Y.Doc
    trackers: Set<string>
    undoManager: Y.UndoManager
  }>()
  const [send, recv] = connection.makeAction<Uint8Array, [string, TextDocumentChangeReason?]>('texts')
  recv((update, peerId, meta) => {
    const [uri, reason] = meta!
    const file = files.get(uri)
    if (file)
      Y.applyUpdateV2(file.doc, update, { reason, peerId })
  })

  async function createTrackedFile(uri: string, uri_: Uri, content?: string) {
    const doc = new Y.Doc()
    const trackers = new Set<string>()
    const undoManager = createCollaborativeUndoManager(doc.getText())
    const file = { doc, trackers, undoManager }
    files.set(uri, file)

    doc.on('updateV2', async (update: Uint8Array, origin: any) => {
      const targetTrackers = origin?.peerId
        ? [...trackers].filter(peerId => peerId !== origin.peerId)
        : [...trackers]
      if (targetTrackers.length === 0) {
        return
      }
      await send(update, targetTrackers, [uri, origin?.reason])
    })

    registerHostTrackedUri(uri_, uri)
    registerTrackedDoc(uri, doc)
    setupTextDocumentUpdater(uri_, doc, undoManager)

    const newText = content ?? await readCurrentTextContent(uri_)
    if (newText) {
      transactSystemChange(doc, () => {
        doc.getText().insert(0, newText)
      })
    }

    return file
  }

  async function ensureTrackedFile(uri: string, content?: string) {
    const uri_ = toHostUri(Uri.parse(uri))
    const file = files.get(uri) ?? await createTrackedFile(uri, uri_, content)
    registerHostTrackedUri(uri_, uri)
    registerTrackedDoc(uri, file.doc)
    if (content !== undefined && file.doc.getText().length === 0) {
      transactSystemChange(file.doc, () => {
        file.doc.getText().insert(0, content)
      })
    }
    return { file, uri_ }
  }

  async function ensureTrackedLocalFile(uri: string) {
    const uri_ = Uri.parse(uri)
    const trackUri = uri_.scheme === CustomUriScheme
      ? uri_
      : toTrackUri(uri_)
    if (!trackUri) {
      return
    }
    await ensureTrackedFile(trackUri.toString())
  }

  ensureHostTrackedContent_ = ensureTrackedLocalFile
  useDisposable({
    dispose() {
      if (ensureHostTrackedContent_ === ensureTrackedLocalFile) {
        ensureHostTrackedContent_ = undefined
      }
    },
  })

  async function trackContent({ guestId, uri, content }: TrackContentRequest) {
    const { file } = await ensureTrackedFile(uri, content)
    file.trackers.add(guestId)
    return Y.encodeStateAsUpdateV2(file.doc)
  }

  async function readCurrentTextContent(uri: Uri) {
    const openDocument = workspace.textDocuments.find(document => document.uri.toString() === uri.toString())
    if (openDocument) {
      return openDocument.getText()
    }
    return new TextDecoder().decode(await workspace.fs.readFile(uri))
  }
  function untrackContent({ guestId, uri }: TrackContentRequest) {
    const file = files.get(uri)
    if (file) {
      file.trackers.delete(guestId)
      maybeDisposeFile(uri)
    }
  }
  async function saveContent(uri: string) {
    const file = files.get(uri)
    if (file) {
      const uri_ = toHostUri(Uri.parse(uri))
      await waitForTextDocumentUpdates(uri_)
      const document = await workspace.openTextDocument(uri_)
      await document.save()
    }
  }

  useTextDocumentWatcher((document) => {
    const uri = getHostTrackedUri(document.uri) ?? toTrackUri(document.uri)?.toString()
    if (!uri)
      return
    return files.get(uri)?.doc
  })

  const [sendSave, _] = connection.makeAction<string>('textSave')
  useDisposable(workspace.onDidSaveTextDocument((document) => {
    const uri = getHostTrackedUri(document.uri) ?? toTrackUri(document.uri)?.toString()
    if (!uri)
      return
    const file = files.get(uri)
    if (file)
      sendSave(uri, [...file.trackers])
  }))
  useDisposable(workspace.onDidCloseTextDocument((document) => {
    const uri = getHostTrackedUri(document.uri) ?? toTrackUri(document.uri)?.toString()
    if (uri) {
      maybeDisposeFile(uri)
    }
  }))

  let currentWatchHandle = 0
  const watchers = new Map<number, IDisposable>()
  const [sendFsChange] = connection.makeAction<FileChangeEvent>('fsChange')

  async function fsWatch(guestId: string, uri: string, options: {
    readonly recursive: boolean
    readonly excludes: readonly string[]
  }) {
    const uri_ = toHostUri(Uri.parse(uri))
    const pattern = options.recursive ? '**/*' : '*'
    const relativePattern = new RelativePattern(uri_, pattern)

    const watcher = workspace.createFileSystemWatcher(relativePattern)
    const isExcluded = picomatch(options.excludes as string[])

    const forwardEvent = async (type: FileChangeType, uri_: Uri) => {
      const uri = toTrackUri(uri_)
      if (!uri || isExcluded(uri.toString()))
        return
      if (type === FileChangeType.Changed) {
        const file = files.get(uri.toString())
        if (file?.trackers.has(guestId)) {
          if (!workspace.textDocuments.some(doc => doc.uri.toString() === uri_.toString())) {
            // If the text document is open, `workspace.onDidChangeTextDocument` will handle the update, otherwise we need to force update here
            const newContent = await workspace.fs.readFile(uri_)
            forceUpdateContent(uri_, file.doc, newContent)
          }
          return
        }
      }
      sendFsChange({ uri: uri.toString(), type }, guestId)
    }

    const handle = currentWatchHandle++
    watchers.set(handle, Disposable.from(
      watcher,
      watcher.onDidCreate(uri_ => forwardEvent(FileChangeType.Created, uri_)),
      watcher.onDidChange(uri_ => forwardEvent(FileChangeType.Changed, uri_)),
      watcher.onDidDelete(uri_ => forwardEvent(FileChangeType.Deleted, uri_)),
    ))
    return handle
  }

  async function fsUnwatch(handle: number) {
    const watcher = watchers.get(handle)
    if (watcher) {
      watcher.dispose()
      watchers.delete(handle)
    }
  }

  async function fsStat(uri: string) {
    const file = files.get(uri)
    const uri_ = toHostUri(Uri.parse(uri))
    if (file) {
      try {
        const stat = await workspace.fs.stat(uri_)
        return {
          ...stat,
          size: file.doc.getText().length,
        }
      }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'FileNotFound') {
          return {
            type: FileType.File,
            ctime: Date.now(),
            mtime: Date.now(),
            size: file.doc.getText().length,
          }
        }
        throw error
      }
    }
    return await workspace.fs.stat(uri_)
  }

  async function fsReadDirectory(uri: string) {
    const uri_ = toHostUri(Uri.parse(uri))
    return await workspace.fs.readDirectory(uri_)
  }

  async function fsCreateDirectory(uri: string) {
    const uri_ = toHostUri(Uri.parse(uri))
    await workspace.fs.createDirectory(uri_)
  }

  async function fsReadFile(uri: string) {
    const file = files.get(uri)
    if (file) {
      return new TextEncoder().encode(file.doc.getText().toString())
    }

    const uri_ = toHostUri(Uri.parse(uri))
    return await workspace.fs.readFile(uri_)
  }

  async function fsWriteFile(uri: string, content: Uint8Array, _options: {
    readonly create: boolean
    readonly overwrite: boolean
  }) {
    const file = files.get(uri)
    if (file) {
      // Rare. Only happens when the file is being edited by a guest who doesn't open the file in the editor
      forceUpdateContent(uri, file.doc, content)
      return
    }

    const uri_ = toHostUri(Uri.parse(uri))
    await workspace.fs.writeFile(uri_, content)
  }

  async function fsDelete(uri: string, options: { readonly recursive: boolean }) {
    const uri_ = toHostUri(Uri.parse(uri))
    await workspace.fs.delete(uri_, options)
  }

  async function fsRename(oldUri: string, newUri: string, options: { readonly overwrite: boolean }) {
    const oldUri_ = toHostUri(Uri.parse(oldUri))
    const newUri_ = toHostUri(Uri.parse(newUri))
    await workspace.fs.rename(oldUri_, newUri_, options)
  }

  function maybeDisposeFile(uri: string) {
    const file = files.get(uri)
    if (!file) {
      return
    }
    const uri_ = toHostUri(Uri.parse(uri))
    const isOpen = workspace.textDocuments.some(document => document.uri.toString() === uri_.toString())
    if (file.trackers.size === 0 && !isOpen) {
      files.delete(uri)
      unregisterTrackedDoc(uri, file.doc)
      unregisterHostTrackedUri(uri_)
      unregisterUndoManager(uri_.toString())
      file.undoManager.destroy()
      file.doc.destroy()
    }
  }

  return {
    trackContent,
    untrackContent,
    saveContent,
    fsWatch,
    fsUnwatch,
    fsStat: fsErrorWrapper(fsStat),
    fsReadDirectory: fsErrorWrapper(fsReadDirectory),
    fsCreateDirectory: fsErrorWrapper(fsCreateDirectory),
    fsReadFile: fsErrorWrapper(fsReadFile),
    fsWriteFile: fsErrorWrapper(fsWriteFile),
    fsDelete: fsErrorWrapper(fsDelete),
    fsRename: fsErrorWrapper(fsRename),
  }
}
