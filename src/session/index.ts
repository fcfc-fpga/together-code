import type { Connection } from '../sync/connection'
import type { HostMeta } from './types'
import type * as Y from 'yjs'
import type { EffectScope, Ref, ShallowRef } from 'reactive-vscode'
import { computed, defineService, onScopeDispose, shallowRef, useCommand, useVscodeContext, watch } from 'reactive-vscode'
import { commands, env, Uri, window, workspace } from 'vscode'
import { version } from '../../package.json'
import { CustomUriScheme } from '../fs/provider'
import { copyShareLink, inquireHostConfig, makeTrackUri, parseTrackUri, validateShareLink } from '../sync/share'
import { useUsers } from '../ui/users'
import { useWebview } from '../webview'
import { createGuestSession } from './guest'
import { createHostSession } from './host'

export interface SessionStateBase {
  role: 'host' | 'guest'
  hostId: string
  hostMeta: HostMeta
  connection: Connection
  doc: Y.Doc
  scope: EffectScope
  gracefulLeave: () => Promise<void>
  shadowTerminals: any
  tunnels: any
}

export interface HostSessionState extends SessionStateBase {
  role: 'host'
}

export interface GuestSessionState extends SessionStateBase {
  role: 'guest'
}

export type ActiveSessionState = HostSessionState | GuestSessionState

export interface ActiveSessionService {
  state: ShallowRef<ActiveSessionState | null>
  role: Ref<ActiveSessionState['role'] | undefined>
  doc: Ref<Y.Doc | undefined>
  selfId: Ref<string | undefined>
  hostId: Ref<string | undefined>
  hostMeta: Ref<HostMeta | undefined>
  peers: Ref<string[] | undefined>
  connection: Ref<Connection | undefined>
  shadowTerminals: Ref<any>
  tunnels: Ref<any>
  isJoining: ShallowRef<boolean>
  makeTrackUri: typeof makeTrackUri
  toTrackUri: (uri: Uri) => Uri | null
  toLocalUri: (uri: Uri) => Uri
  host: () => Promise<void>
  join: (newWindow: boolean | 'auto') => Promise<void>
  leave: () => Promise<void>
}

export const useActiveSession = defineService((): ActiveSessionService => {
  const session = shallowRef<ActiveSessionState | null>(null)
  const isJoining = shallowRef(true)

  setTimeout(async () => {
    const folder = workspace.workspaceFolders?.find(folder => folder.uri.scheme === CustomUriScheme)
    try {
      if (folder) {
        await joinImpl(folder.uri)
      }
    }
    finally {
      isJoining.value = false
    }
  })

  function toTrackUri(uri: Uri) {
    if (!session.value) {
      throw new Error('当前不在会话中')
    }
    if (session.value.role === 'guest') {
      return uri
    }
    return session.value.connection.toTrackUri(uri)
  }

  function toLocalUri(uri: Uri) {
    if (!session.value) {
      throw new Error('当前不在会话中')
    }
    if (session.value.role === 'guest') {
      return uri
    }
    return session.value.connection.toHostUri(uri)
  }

  async function host() {
    if (session.value) {
      window.showErrorMessage('你已在会话中。')
      return
    }
    if (isJoining.value) {
      return
    }
    isJoining.value = true
    try {
      const [config, _] = await Promise.all([
        inquireHostConfig(),
        useWebview().ensureReady(),
      ])
      if (!config) {
        return
      }

      try {
        session.value = await createHostSession(config)
      }
      catch (error: any) {
        console.error(error)
        window.showErrorMessage(
          '协同编码：发起会话失败。',
          {
            modal: true,
            detail: error?.message || String(error),
          },
        )
        return
      }

      copyShareLink(config, true)
    }
    finally {
      isJoining.value = false
    }
  }

  async function join(newWindow: boolean | 'auto') {
    if (session.value) {
      window.showErrorMessage('你已在会话中。')
      return
    }
    if (isJoining.value) {
      return
    }
    isJoining.value = true
    try {
      const clipboard = await env.clipboard.readText()
      const uriStr = await window.showInputBox({
        prompt: '输入邀请链接',
        // placeHolder: 'room-id',
        value: validateShareLink(clipboard) === null ? clipboard : undefined,
        validateInput: validateShareLink,
      })
      if (!uriStr) {
        return
      }
      let uri = Uri.parse(uriStr.trim())
      if (uri.path === '') {
        uri = uri.with({ path: '/' })
      }

      if (newWindow) {
        commands.executeCommand('vscode.openFolder', uri, newWindow === 'auto'
          ? undefined
          : {
              forceNewWindow: newWindow,
              forceReuseWindow: !newWindow,
            })
      }
      else {
        const parsed = parseTrackUri(uri)
        workspace.updateWorkspaceFolders(0, workspace.workspaceFolders?.length ?? 0, {
          uri,
          name: `协同编码 (${parsed?.roomId})`,
        })
        await joinImpl(uri)
      }
    }
    finally {
      isJoining.value = false
    }
  }

  async function joinImpl(uri: Uri) {
    const parsed = parseTrackUri(uri)
    if (!parsed) {
      window.showErrorMessage(
        '协同编码：邀请链接无效。',
        {
          modal: true,
          detail: '你提供的链接无效，请检查后重试。有效链接示例：together-code://ws.room.domain:port/ 或 together-code://trystero.room.mqtt/',
        },
      )
      return
    }

    const { inquireUserName } = useUsers()

    const [name, _] = await Promise.all([
      inquireUserName(false),
      useWebview().ensureReady(),
    ])
    if (!name) {
      return
    }

    try {
      session.value = await createGuestSession(parsed)
    }
    catch (error: any) {
      console.error(error)
      window.showErrorMessage(
        '协同编码：加入会话失败。',
        {
          modal: true,
          detail: error?.message || String(error),
        },
      )
    }
  }

  async function leave() {
    if (!session.value) {
      window.showErrorMessage('当前不在会话中。')
      return
    }

    const wasGuest = session.value.role === 'guest'

    const res = await window.showInformationMessage(
      wasGuest ? '确认离开当前会话？' : '确认结束当前共享会话？',
      {
        modal: true,
        detail: wasGuest ? '未保存的更改可能会丢失。' : '结束后将停止共享当前工作区，所有访客都会断开连接。',
      },
      '离开',
    )

    if (res === '离开') {
      await session.value.gracefulLeave?.()
      session.value = null
      if (wasGuest) {
        workspace.updateWorkspaceFolders(0, workspace.workspaceFolders?.length)
      }
      window.showInformationMessage('你已离开会话。')
    }
  }

  watch(session, (_, oldState) => oldState?.scope.stop())
  onScopeDispose(() => session.value?.scope.stop())

  useVscodeContext('together-code:inSession', computed(() => !!session.value))
  useVscodeContext('together-code:isHost', computed(() => session.value?.role === 'host'))
  useVscodeContext('together-code:isGuest', computed(() => session.value?.role === 'guest'))

  useCommand('together-code.host', host)
  useCommand('together-code.join', () => join(false))
  useCommand('together-code.joinNewWindow', () => join(true))
  useCommand('together-code.leave', leave)
  useCommand('together-code.stop', leave)
  useCommand('together-code.copyInviteLink', () => {
    if (session.value?.connection) {
      copyShareLink(session.value?.connection.config)
    }
    else {
      window.showErrorMessage('当前不在会话中。')
    }
  })

  return {
    state: session,
    role: computed(() => session.value?.role),
    doc: computed(() => session.value?.doc),
    selfId: computed(() => session.value?.connection.selfId),
    hostId: computed(() => session.value?.hostId),
    hostMeta: computed(() => session.value?.hostMeta),
    peers: computed(() => session.value?.connection.peers.value),
    connection: computed(() => session.value?.connection),
    shadowTerminals: computed(() => session.value?.shadowTerminals),
    tunnels: computed(() => session.value?.tunnels),
    isJoining,
    makeTrackUri,
    toTrackUri,
    toLocalUri,
    host,
    join,
    leave,
  }
}) as unknown as (() => ActiveSessionService)

export function onSessionClosed(options: {
  title: string
  detail: string
}) {
  const { state } = useActiveSession()
  if (!state.value) {
    return
  }
  const config = state.value.connection.config
  const creator = state.value.role === 'host' ? createHostSession : createGuestSession

  state.value = null
  const delay = new Promise(resolve => setTimeout(resolve, 500))
  window.showErrorMessage(
    options.title,
    {
      modal: true,
      detail: options.detail,
    },
    '重新连接',
  ).then(async (choice) => {
    if (choice === '重新连接') {
      await delay
      state.value = await creator(config)
    }
  })
}

export const ProtocolVersion = version
