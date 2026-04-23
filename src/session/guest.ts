import type { ConnectionConfig } from '../sync/share'
import type { HostMeta } from './types'
import type { GuestSessionState } from './index'
import { effectScope, watchEffect } from 'reactive-vscode'
import { ProgressLocation, window } from 'vscode'
import * as Y from 'yjs'
import { useGuestDiagnostics } from '../diagnostics/guest'
import { useGuestFs } from '../fs/guest'
import { useGuestLs } from '../ls/guest'
import { useGuestRpc } from '../rpc/guest'
import { useGuestScm } from '../scm/guest'
import { useConnection } from '../sync/connection'
import { useDocSync } from '../sync/doc'
import { useGuestTerminals } from '../terminal/guest'
import { useTunnels } from '../tunnel'
import { useUsers } from '../ui/users'
import { useWebview } from '../webview'
import { onSessionClosed, ProtocolVersion } from './index'

export async function createGuestSession(config: ConnectionConfig): Promise<GuestSessionState | null> {
  const scope = effectScope(true)
  const connection = scope.run(() => useConnection(config))!
  await connection.ready

  const [_, recvInit] = connection.makeAction<Uint8Array, HostMeta>('init')
  const initResult = await window.withProgress(
    {
      location: ProgressLocation.Notification,
      title: '协同编码：正在加入会话...',
      cancellable: true,
    },
    (_progress, token) => new Promise<null | [Uint8Array, string, HostMeta]>((resolve) => {
      token.onCancellationRequested(() => resolve(null))
      const timeoutId = setTimeout(async () => {
        const res = await window.showErrorMessage(
          '协同编码：15 秒内仍未找到主机。',
          {
            modal: true,
            detail: '请确认主机在线，并且你输入的邀请链接正确。',
          },
          '继续等待',
        )
        if (!res) {
          resolve(null)
        }
      }, 15000)
      recvInit((data, hostId, hostMeta) => {
        resolve([data, hostId, hostMeta!])
        clearTimeout(timeoutId)
      })
    }),
  )
  if (!initResult) {
    return null
  }
  const [initUpdate, hostId, hostMeta] = initResult

  if (!ProtocolVersion.includes(hostMeta.version)) {
    await window.showErrorMessage(
      '协同编码：主机版本不兼容。',
      {
        modal: true,
        detail: `主机版本：${hostMeta.version}\n本地版本：${ProtocolVersion}`,
      },
    )
    return null
  }

  return scope.run(() => {
    const doc = new Y.Doc()
    useDocSync(connection, doc)
    Y.applyUpdateV2(doc, initUpdate)

    const rpc = useGuestRpc(connection, hostId)
    useGuestFs(connection, rpc, hostId)
    const { shadowTerminals } = useGuestTerminals(connection, doc, rpc, hostId)
    useGuestLs(connection, hostId)
    useGuestDiagnostics(doc)
    useGuestScm(doc, rpc)
    const tunnels = useTunnels(connection, doc)
    useWebview().useChat(connection, { role: 'guest', hostId })
    const currentUser = useUsers().useCurrentUser(connection, doc)

    watchEffect(() => {
      if (!connection.peers.value.includes(hostId)) {
        setTimeout(() => {
          onSessionClosed({
            title: '协同编码：主机已断开连接。',
            detail: '这可能是网络问题导致的，也可能是主机已经关闭了会话。',
          })
        })
      }
    })

    return {
      role: 'guest' as const,
      hostId,
      hostMeta,
      connection,
      doc,
      scope,
      gracefulLeave: currentUser.gracefulLeave,
      shadowTerminals,
      tunnels,
    }
  })!
}
