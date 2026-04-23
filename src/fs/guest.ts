import type { BirpcReturn } from 'birpc'
import type { TextDocumentChangeReason } from 'vscode'
import type { GuestFunctions, HostFunctions } from '../rpc/types'
import type { Connection } from '../sync/connection'
import type { FileChangeEvent } from './common'
import { computed, defineConfig, onScopeDispose, useDisposable } from 'reactive-vscode'
import { FileType, Uri, workspace } from 'vscode'
import * as Y from 'yjs'
import { createCollaborativeUndoManager, forceUpdateContent, handleFsError, registerTrackedDoc, setupTextDocumentUpdater, unregisterTrackedDoc, unregisterUndoManager, useTextDocumentWatcher, waitForTextDocumentUpdates } from './common'
import { CustomUriScheme, useFsProvider } from './provider'

const filesConfig = defineConfig<any>('files')
let ensureGuestTrackedContent_: ((uri: string) => Promise<void>) | undefined

export async function ensureGuestTrackedContent(uri: Uri | string) {
  await ensureGuestTrackedContent_?.(uri.toString())
}

export function useGuestFs(connection: Connection, rpc: BirpcReturn<HostFunctions, GuestFunctions>, hostId: string) {
  const { fileChanged, useSetActiveProvider } = useFsProvider()

  const files = new Map<string, {
    doc: Y.Doc
    mtime: number
    ctime?: number
    undoManager: Y.UndoManager
  }>()
  const pendingTrackContent = new Map<string, Promise<void>>()
  const [send, recv] = connection.makeAction<Uint8Array, [string, TextDocumentChangeReason?]>('texts')

  recv((update, peerId, meta) => {
    const [uri, reason] = meta!
    const file = files.get(uri)
    if (file)
      Y.applyUpdateV2(file.doc, update, { reason, peerId })
  })

  async function trackContent(uri: string) {
    if (files.has(uri)) {
      return
    }

    const pending = pendingTrackContent.get(uri)
    if (pending) {
      await pending
      return
    }

    const promise = (async () => {
      const doc = new Y.Doc()
      const init = await rpc.trackContent({ guestId: connection.selfId, uri })
      const stat = await rpc.fsStat(uri)
      Y.applyUpdateV2(doc, init)
      const undoManager = createCollaborativeUndoManager(doc.getText())
      files.set(uri, {
        doc,
        mtime: handleFsError(stat).mtime,
        undoManager,
      })
      registerTrackedDoc(uri, doc)

      doc.on('updateV2', async (update: Uint8Array, origin: any) => {
        if (origin?.peerId)
          return
        await send(update, hostId, [uri, origin?.reason])
      })
      setupTextDocumentUpdater(Uri.parse(uri), doc, undoManager)
    })().finally(() => {
      pendingTrackContent.delete(uri)
    })

    pendingTrackContent.set(uri, promise)
    await promise
  }

  ensureGuestTrackedContent_ = trackContent
  onScopeDispose(() => {
    if (ensureGuestTrackedContent_ === trackContent) {
      ensureGuestTrackedContent_ = undefined
    }
  })

  useTextDocumentWatcher((document) => {
    if (document.uri.scheme === CustomUriScheme) {
      const uri = document.uri.toString()
      const file = files.get(uri)
      if (file)
        return file.doc

      console.warn('Document updated before tracking:', uri)
      trackContent(uri)
    }
  })

  useDisposable(workspace.onDidOpenTextDocument(({ uri }) => {
    if (uri.scheme === CustomUriScheme)
      trackContent(uri.toString())
  }))
  useDisposable(workspace.onDidCloseTextDocument(({ uri }) => {
    if (uri.scheme === CustomUriScheme) {
      const file = files.get(uri.toString())
      files.delete(uri.toString())
      unregisterTrackedDoc(uri.toString(), file?.doc)
      unregisterUndoManager(uri.toString())
      file?.undoManager.destroy()
      rpc.untrackContent({ guestId: connection.selfId, uri: uri.toString() })
    }
  }))

  const willSaveDocuments = new Set<string>()
  const remoteSaveDocuments = new Set<string>()
  const [__, recvSave] = connection.makeAction<string>('textSave')
  const autoSave = computed(() => filesConfig.autoSave === 'afterDelay')
  recvSave(async (uri) => {
    if (autoSave.value)
      return
    const file = files.get(uri)
    if (file) {
      await waitForTextDocumentUpdates(uri)
      const document = await workspace.openTextDocument(Uri.parse(uri))
      if (document.isDirty) {
        remoteSaveDocuments.add(uri)
        try {
          await document.save()
        }
        finally {
          remoteSaveDocuments.delete(uri)
        }
      }
    }
  })

  useDisposable(workspace.onWillSaveTextDocument(({ document }) => {
    if (document.uri.scheme === CustomUriScheme) {
      willSaveDocuments.add(document.uri.toString())
    }
  }))

  const [_, recvFsChange] = connection.makeAction<FileChangeEvent>('fsChange')
  recvFsChange(({ uri, type }) => fileChanged([{ uri: Uri.parse(uri), type }]))

  useSetActiveProvider({
    watch(uri_, options) {
      const handle = rpc.fsWatch(connection.selfId, uri_.toString(), options)
      return {
        async dispose() {
          await rpc.fsUnwatch(await handle)
        },
      }
    },
    async stat(uri) {
      const file = files.get(uri.toString())
      if (file) {
        return {
          type: FileType.File,
          ctime: file.ctime ??= handleFsError(await rpc.fsStat(uri.toString())).ctime,
          mtime: file.mtime,
          size: file.doc.getText().length,
        }
      }
      return handleFsError(await rpc.fsStat(uri.toString()))
    },
    async readDirectory(uri) {
      return handleFsError(await rpc.fsReadDirectory(uri.toString()))
    },
    async createDirectory(uri) {
      return handleFsError(await rpc.fsCreateDirectory(uri.toString()))
    },
    async readFile(uri) {
      return handleFsError(await rpc.fsReadFile(uri.toString()))
    },
    async writeFile(uri, content, options) {
      const uriString = uri.toString()
      const file = files.get(uriString)
      if (file) {
        const isWillSave = willSaveDocuments.delete(uriString)
        const isRemoteSave = remoteSaveDocuments.delete(uriString)
        if (!isWillSave && !isRemoteSave) {
          // `workspace.fs.writeFile` by other extension
          forceUpdateContent(uri, file.doc, content)
        }
        if (!isRemoteSave) {
          // Ensure saved to the disk
          await rpc.saveContent(uriString)
        }
        file.mtime = Date.now()
        return
      }
      return handleFsError(await rpc.fsWriteFile(uriString, content, options))
    },
    async delete(uri, options) {
      return handleFsError(await rpc.fsDelete(uri.toString(), options))
    },
    async rename(oldUri, newUri, options) {
      return handleFsError(await rpc.fsRename(oldUri.toString(), newUri.toString(), options))
    },
  })
}
