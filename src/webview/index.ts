import type * as trystero from 'trystero'
import type { Connection, InternalReceiver, InternalSender } from '../sync/connection'
import type { ChatMessage } from './components/Chat'
import { createBirpc } from 'birpc'
import { computed, defineService, extensionContext, onScopeDispose, ref, shallowRef, useEventEmitter, useWebviewView, watch, watchEffect } from 'reactive-vscode'
import { commands, Uri, workspace } from 'vscode'
import { useActiveSession } from '../session'
import { useSelections } from '../ui/selections'
import { useUsers } from '../ui/users'
import { logger } from '../utils'

export interface WebviewFunctions {
  trysteroJoinRoom: (
    strategy: string,
    config: trystero.BaseRoomConfig & trystero.RelayConfig & trystero.TurnConfig,
    roomId: string,
  ) => void
  trysteroSend: InternalSender
  trysteroListenAction: (action: string) => void
  trysteroLeaveRoom: () => void

  recvChatMessage: (message: ChatMessage | 'clear') => void
  updateUIState: (state: UIState) => void
}

export interface TrysteroHandlers {
  onTrysteroError: (message: string) => void
  onTrysteroUpdatePeers: (peers: string[]) => void
  onTrysteroMessage: InternalReceiver
}

export interface ExtensionFunctions extends TrysteroHandlers {
  share: () => void
  join: (newWindow: boolean | 'auto') => void
  leave: () => void
  jumpToParticipant: (peerId: string) => void
  copyInviteLink: () => void

  getPlatform: () => 'web' | 'desktop'
  sendChatMessage: (content: any) => void
  ping: (peerId: string) => Promise<number>
  getSelfIdentity: () => Promise<string | null>
  getSelfName: () => Promise<string | null>
}

export interface UIParticipant {
  id: string
  name: string
  avatarUrl: string | null
  color: {
    fg: string
    bg: string
  }
  isHost: boolean
  isSelf: boolean
  ping: number | null
  positionLabel: string | null
}

export type UIState = 'none' | 'joining' | {
  role: 'host' | 'guest'
  selfId: string
  hostId: string
  roomId: string
  peers: string[]
  participants: UIParticipant[]
}

const MaxSyncedChatHistory = 100

export const useWebview = defineService(() => {
  const trysteroHandlers = shallowRef<TrysteroHandlers | null>(null)
  const chatHistory = ref<ChatMessage[]>([])

  const isReady = ref<{ trysteroSelfId: string } | null>(null)
  let onReady: (() => void) | null = null
  let readyPromise = Promise.resolve()
  resetReady()

  function resetReady() {
    isReady.value = null
    readyPromise = new Promise<void>((resolve) => {
      onReady = resolve
    })
  }

  function markReady(data: { trysteroSelfId: string }) {
    isReady.value = data
    onReady?.()
    onReady = null
    queueMicrotask(() => {
      void syncChatHistory()
    })
  }

  function getChatMessageKey(message: ChatMessage) {
    if (message.id) {
      return message.id
    }
    const attachments = message.attachments?.length
      ? message.attachments
      : message.file
        ? [message.file]
        : message.image
          ? [{
              name: '共享图片',
              type: 'image/*',
              size: 0,
              base64: message.image,
            }]
          : []
    if (attachments.length > 0) {
      const attachmentKey = attachments
        .map(attachment => `${attachment.name}:${attachment.size}:${attachment.type}:${attachment.base64.slice(0, 64)}`)
        .join('|')
      return `${message.sender}:${message.timestamp}:attachments:${attachmentKey}:text:${message.content ?? ''}`
    }
    return `${message.sender}:${message.timestamp}:text:${message.content ?? ''}`
  }

  function appendChatHistory(message: ChatMessage) {
    const key = getChatMessageKey(message)
    if (chatHistory.value.some(existing => getChatMessageKey(existing) === key)) {
      return
    }
    chatHistory.value = [...chatHistory.value, message].slice(-MaxSyncedChatHistory)
  }

  async function syncChatHistory() {
    if (!isReady.value) {
      return
    }
    await rpc.recvChatMessage('clear')
    for (const message of chatHistory.value) {
      await rpc.recvChatMessage(message)
    }
  }

  const webviewEvent = useEventEmitter<any>()
  const rpc = createBirpc<WebviewFunctions, ExtensionFunctions>(
    {
      getPlatform() {
        return import.meta.env.TARGET === 'browser' ? 'web' : 'desktop'
      },
      onTrysteroError(message) {
        trysteroHandlers.value?.onTrysteroError(message)
      },
      onTrysteroUpdatePeers(peers) {
        trysteroHandlers.value?.onTrysteroUpdatePeers(peers)
      },
      onTrysteroMessage(...args) {
        trysteroHandlers.value?.onTrysteroMessage(...args)
      },
      share() {
        useActiveSession().host()
      },
      join(newWindow) {
        useActiveSession().join(newWindow)
      },
      leave() {
        useActiveSession().leave()
      },
      jumpToParticipant(peerId) {
        commands.executeCommand('together-code.jumpToParticipant', peerId)
      },
      copyInviteLink() {
        commands.executeCommand('together-code.copyInviteLink')
      },
      sendChatMessage(content) {
        appendChatHistory(content)
        sendChatMessage.value?.(content)
      },
      async ping(peerId) {
        const { connection } = useActiveSession()
        return connection.value!.ping(peerId)
      },
      getSelfIdentity() {
        return useUsers().inquireUserIdentity()
      },
      getSelfName() {
        return useUsers().inquireUserName(false)
      },
    },
    {
      post: async (data) => {
        await readyPromise
        const result = await postMessage(data)
        if (!result) {
          logger.error('Failed to post message to webview')
          console.error('Failed to post message to webview')
        }
      },
      on: fn => webviewEvent.event(fn),
    },
  )

  function getAssetUri(fileName: string): Uri {
    return view.value!.webview.asWebviewUri(Uri.joinPath(extensionContext.value!.extensionUri, 'dist', fileName))
  }
  const html = computed(() => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>协同编码</title>
    <link rel="stylesheet" href="${getAssetUri('webview.css')}">
    <script type="module" src="${getAssetUri('webview.mjs')}"></script>
</head>
<body>
    <div id="app"></div>
</body>
</html>`)

  // Set up the webview using useWebviewView
  const { postMessage, view } = useWebviewView(
    'together-code.webview',
    html,
    {
      retainContextWhenHidden: true,
      webviewOptions: {
        enableScripts: true,
      },
      onDidReceiveMessage: (data) => {
        if (data.__webview_ready__) {
          markReady(data)
        }
        else {
          webviewEvent.fire(data)
        }
      },
    },
  )

  function showWebview() {
    commands.executeCommand('together-code.webview.focus')
    view.value?.show(true)
  }

  async function ensureReady() {
    if (!isReady.value) {
      showWebview()
    }
    await readyPromise
  }

  const sendChatMessage = ref<(content: any) => void>()
  function useChat(connection: Connection, options: {
    role: 'host'
  } | {
    role: 'guest'
    hostId: string
  }) {
    const [send, recv] = connection.makeAction<ChatMessage>('chat')
    const [sendHistory, recvHistory] = connection.makeAction<ChatMessage[]>('chatHist')
    const [sendHistoryRequest, recvHistoryRequest] = connection.makeAction<null>('chatReq')

    sendChatMessage.value = send
    recv((message) => {
      appendChatHistory(message)
      void rpc.recvChatMessage(message)
    })
    recvHistory((messages) => {
      for (const message of messages) {
        appendChatHistory(message)
        void rpc.recvChatMessage(message)
      }
    })
    if (options.role === 'host') {
      recvHistoryRequest((_data, peerId) => {
        const history = chatHistory.value.slice(-MaxSyncedChatHistory)
        if (history.length > 0) {
          void sendHistory(history, peerId)
        }
      })
    }
    else {
      queueMicrotask(() => {
        void sendHistoryRequest(null, options.hostId)
      })
    }
    onScopeDispose(() => {
      chatHistory.value = []
      sendChatMessage.value = undefined
      void rpc.recvChatMessage('clear')
    })
  }

  setTimeout(() => {
    const { state, isJoining, toLocalUri } = useActiveSession()
    const { getSelection } = useSelections()
    const { getUserInfo, knownPeerIds, departedPeerIds } = useUsers()
    const participantPings = ref<Record<string, number>>({})

    const participantIds = computed(() => {
      const sessionState = state.value
      if (!sessionState) {
        return []
      }

      const livePeerIds = [...new Set([
        sessionState.connection.selfId,
        sessionState.hostId,
        ...sessionState.connection.peers.value,
      ])]
      const hiddenPeerIds = new Set(departedPeerIds.value)
      return [...new Set([
        ...livePeerIds,
        ...knownPeerIds.value,
      ])].filter(peerId => peerId === sessionState.connection.selfId || peerId === sessionState.hostId || !hiddenPeerIds.has(peerId))
    })

    async function refreshParticipantPings() {
      const sessionState = state.value
      if (!sessionState) {
        if (Object.keys(participantPings.value).length > 0) {
          participantPings.value = {}
        }
        return
      }

      const pingEntries = await Promise.all(participantIds.value
        .filter(peerId => peerId !== sessionState.connection.selfId)
        .map(async peerId => [peerId, await sessionState.connection.ping(peerId)] as const))
      participantPings.value = Object.fromEntries(pingEntries)
    }

    function getParticipantPositionLabel(peerId: string) {
      const selection = getSelection(peerId)
      if (!selection) {
        return null
      }

      const localUri = toLocalUri(Uri.parse(selection.uri))
      const relativePath = workspace.asRelativePath(localUri, false)
      const path = relativePath || localUri.fsPath || localUri.path
      const activeLine = selection.fallbackSelections.at(-1)?.[2]
      return activeLine === undefined ? path : `${path}:${activeLine + 1}`
    }

    const participants = computed(() => {
      const sessionState = state.value
      if (!sessionState) {
        return []
      }

      return participantIds.value
        .map((peerId) => {
          const user = getUserInfo(peerId)
          return {
            id: peerId,
            name: user.name,
            avatarUrl: user.avatarUrl,
            color: {
              fg: user.color.fg,
              bg: user.color.bg,
            },
            isHost: peerId === sessionState.hostId,
            isSelf: peerId === sessionState.connection.selfId,
            ping: peerId === sessionState.connection.selfId ? null : participantPings.value[peerId] ?? null,
            positionLabel: getParticipantPositionLabel(peerId),
          } satisfies UIParticipant
        })
        .sort((a, b) => {
          if (a.isSelf && !b.isSelf) {
            return -1
          }
          if (!a.isSelf && b.isSelf) {
            return 1
          }
          if (a.isHost && !b.isHost) {
            return -1
          }
          if (!a.isHost && b.isHost) {
            return 1
          }
          return a.name.localeCompare(b.name, 'zh-CN')
        })
    })

    watch(view, (newView, oldView) => {
      if (oldView && newView !== oldView) {
        resetReady()
      }
    })

    watchEffect(() => {
      void state.value?.connection.peers.value
      void knownPeerIds.value
      void departedPeerIds.value
      void refreshParticipantPings()
    })
    setInterval(() => {
      void refreshParticipantPings()
    }, 5000)

    watchEffect(() => {
      if (!view.value || !isReady.value) {
        return
      }
      if (isJoining.value) {
        rpc.updateUIState('joining')
      }
      else if (!state.value) {
        rpc.updateUIState('none')
      }
      else {
        rpc.updateUIState({
          role: state.value.role,
          selfId: state.value.connection.selfId,
          hostId: state.value.hostId,
          roomId: state.value.connection.config.roomId,
          peers: state.value.connection.peers.value,
          participants: participants.value,
        })
      }
    })
  })

  return {
    rpc,
    trysteroHandlers,
    get trysteroSelfId() {
      return isReady.value!.trysteroSelfId
    },
    showWebview,
    ensureReady,
    useChat,
  }
})
