import type { Command } from 'vscode'
import getPort, { portNumbers } from 'get-port'
import { computed, defineService, useCommands, useTreeView, useVscodeContext } from 'reactive-vscode'
import { env, ThemeIcon, window } from 'vscode'
import { useActiveSession } from '../session'
import { useUsers } from './users'

export const useTunnelsTree = defineService(() => {
  useVscodeContext('together-code:supportsTunnels', true)

  const { tunnels, selfId } = useActiveSession()

  const sharedServers = computed<Map<string, ReadonlyMap<string, unknown>> | undefined>(() => tunnels.value?.sharedServers)
  const connectedServers = computed<Map<string, { host: string, port: number }> | undefined>(() => tunnels.value?.connectedServers)
  const allTunnels = computed<any[]>(() => tunnels.value ? Array.from((tunnels.value.serversMap as Map<string, any>).values()) : [])
  const hostByMe = computed<any[]>(() => allTunnels.value
    .filter((t: any) => t.peerId === selfId.value)
    .sort((a: any, b: any) => b.createdAt - a.createdAt))
  const connected = computed<any[]>(() => allTunnels.value
    .filter((t: any) => connectedServers.value?.has(t.serverId))
    .sort((a: any, b: any) => b.createdAt - a.createdAt))
  const available = computed<any[]>(() => allTunnels.value
    .filter((t: any) => t.peerId !== selfId.value && !connectedServers.value?.has(t.serverId))
    .sort((a: any, b: any) => b.createdAt - a.createdAt))

  useTreeView(
    'together-code.tunnels',
    computed(() => [...hostByMe.value, ...connected.value, ...available.value].map((tunnel: any) => {
      const serving = sharedServers.value?.get(tunnel.serverId)
      const client = connectedServers.value?.get(tunnel.serverId)

      const servedBy = serving ? '你' : useUsers().getUserInfo(tunnel.peerId)?.name || `未知（${tunnel.peerId}）`

      let description: string
      if (serving) {
        description = `（${serving.size} 个客户端）`
      }
      else if (client) {
        description = `（本地地址：${client.host}:${client.port}）`
      }
      else {
        description = '（点击连接）'
      }

      let tooltip: string | undefined
      if (serving) {
        tooltip = `已连接客户端：\n${getClientsNames(serving).map(s => `- ${s}`).join('\n')}`
      }

      let command: Command | undefined
      if (serving) {
        command = undefined
      }
      else if (client) {
        command = {
          command: 'together-code.copySharedServerLocalURL',
          title: '复制本地地址',
          arguments: [tunnel],
        }
      }
      else {
        command = {
          command: 'together-code.connectToSharedServer',
          title: '连接共享服务',
          arguments: [tunnel],
        }
      }

      return {
        treeItem: {
          serverId: tunnel.serverId,
          label: `${tunnel.name}（来自 ${servedBy}）`,
          description,
          tooltip,
          iconPath: new ThemeIcon(serving ? 'cloud-upload' : client ? 'cloud-download' : 'cloud'),
          contextValue: serving ? 'serving' : client ? 'connected' : 'available',
          command,
        },
      }
    })),
  )

  useCommands({
    'together-code.shareServer': async () => {
      if (!tunnels.value) {
        window.showWarningMessage('当前没有活动会话，或当前环境不支持该功能。')
        return
      }
      const { createTunnel } = tunnels.value
      const urlOrPort = await window.showInputBox({
        title: '共享服务',
        prompt: '输入要共享的 TCP 端口或服务地址。',
        placeHolder: '例如：5173、http://localhost:5173',
        validateInput(value) {
          if (!value.trim()) {
            return
          }
          const parsed = parsePortOrUrl(value)
          if (typeof parsed === 'string') {
            return parsed
          }
        },
      })
      if (!urlOrPort?.trim()) {
        return
      }
      const parsed = parsePortOrUrl(urlOrPort)
      if (typeof parsed === 'string') {
        window.showErrorMessage(`解析输入失败：${parsed}`)
        return
      }
      const { port, host } = parsed
      createTunnel(port, host)
    },
    'together-code.stopSharingServer': async (item?: any) => {
      if (!tunnels.value) {
        window.showWarningMessage('当前没有活动会话，或当前环境不支持该功能。')
        return
      }
      const { closeTunnel } = tunnels.value
      let serverId = (item?.treeItem || item)?.serverId
      if (!serverId) {
        serverId = await window.showQuickPick(
          hostByMe.value.map((info: any) => ({
            label: info.name,
            description: `${info.host}:${info.port}`,
            serverId: info.serverId,
          })),
          { placeHolder: '选择要停止共享的服务' },
        ).then(item => item?.serverId)
      }
      if (!serverId) {
        return
      }
      const info = tunnels.value.serversMap.get(serverId)
      const shareInfo = sharedServers.value?.get(serverId)
      if (!info || !shareInfo) {
        window.showWarningMessage(`找不到服务，或该服务并非由你共享：${serverId}`)
        return
      }
      const clients = getClientsNames(shareInfo).map(s => `- ${s}`).join('\n')
      if (shareInfo.size > 0) {
        const result = await window.showInformationMessage(
          `即将停止共享服务 ${info.name}`,
          {
            modal: true,
            detail: `当前有 ${shareInfo.size} 个已连接客户端：\n${clients}`,
          },
          '停止共享',
        )
        if (result === '停止共享') {
          closeTunnel(serverId)
        }
      }
      else {
        closeTunnel(serverId)
      }
    },
    'together-code.connectToSharedServer': async (item?: any) => {
      if (!tunnels.value) {
        window.showWarningMessage('当前没有活动会话，或当前环境不支持该功能。')
        return
      }
      const { serversMap, linkTunnel } = tunnels.value
      let serverId = (item?.treeItem || item)?.serverId
      if (!serverId) {
        serverId = await window.showQuickPick(
          available.value.map((info: any) => ({
            label: info.name,
            description: `${info.host}:${info.port}`,
            serverId: info.serverId,
          })),
          { placeHolder: '选择要连接的共享服务' },
        ).then(item => item?.serverId)
      }
      if (!serverId) {
        return
      }
      const port = await window.withProgress({
        location: { viewId: 'together-code.tunnels' },
        title: '正在连接共享服务...',
        cancellable: false,
      }, async () => {
        const serverInfo = serversMap.get(serverId)!
        const port = await getPort({ port: portNumbers(serverInfo.port, serverInfo.port + 100) })
        await linkTunnel(serverId, port, 'localhost')
        return port
      })

      await env.clipboard.writeText(`localhost:${port}`)
      window.showInformationMessage(`已连接到服务。本地地址 localhost:${port} 已复制到剪贴板。`)
    },
    'together-code.disconnectFromSharedServer': async (item?: any) => {
      if (!tunnels.value) {
        window.showWarningMessage('当前没有活动会话，或当前环境不支持该功能。')
        return
      }
      const { unlinkTunnel } = tunnels.value
      let serverId = (item?.treeItem || item)?.serverId
      if (!serverId) {
        serverId = await window.showQuickPick(
          connected.value.map((info: any) => ({
            label: info.name,
            description: `${info.host}:${info.port}`,
            serverId: info.serverId,
          })),
          { placeHolder: '选择要断开的共享服务' },
        ).then(item => item?.serverId)
      }
      if (!serverId) {
        return
      }
      unlinkTunnel(serverId)
    },
    'together-code.copySharedServerLocalURL': async (item?: any) => {
      if (!tunnels.value) {
        window.showWarningMessage('当前没有活动会话，或当前环境不支持该功能。')
        return
      }
      const { connectedServers } = tunnels.value
      const serverId = (item?.treeItem || item)?.serverId
      if (!serverId) {
        throw new Error('缺少服务 ID。')
      }
      const client = connectedServers.get(serverId)
      if (!client) {
        window.showWarningMessage('尚未连接到所选服务。')
        return
      }
      const localURL = `${client.host}:${client.port}`
      await env.clipboard.writeText(localURL)
      window.showInformationMessage(`本地地址 ${localURL} 已复制到剪贴板。`)
    },
  })

  function getClientsNames(shareInfo: ReadonlyMap<string, unknown>) {
    const { getUserInfo } = useUsers()
    return Array.from(shareInfo.keys()).map((peerId) => {
      const user = getUserInfo(peerId)
      return user?.name || `未知（${peerId}）`
    })
  }
})

/**
 * Valid inputs:
 * - 8080
 * - localhost:8080
 * - example.com:8080
 * - http://localhost:8080
 * - https://example.com:8080
 * - http://example.com (default port 80)
 */
function parsePortOrUrl(input: string) {
  input = input.trim()
  const port = Number(input)
  if (Number.isFinite(port)) {
    if (port <= 0 || port >= 65536) {
      return '端口号无效。'
    }
    return { port, host: 'localhost' }
  }
  let defaultPort = null
  input = input.replace(/^(\w+):\/\//, (_, scheme) => {
    defaultPort = schemeToPort[scheme.toLowerCase()] || null
    return ''
  })
  const parts = input.split('/', 1)[0].split(':')
  if (parts.length === 1) {
    const host = parts[0]
    if (defaultPort === null) {
      return '输入无效。'
    }
    return { port: defaultPort, host }
  }
  else if (parts.length === 2) {
    const host = parts[0]
    const port = Number(parts[1])
    if (Number.isNaN(port) || port <= 0 || port >= 65536) {
      return '端口号无效。'
    }
    return { port, host }
  }
  return '输入无效。'
}

const schemeToPort: Record<string, number> = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
  ftp: 21,
  ftps: 990,
  ssh: 22,
  telnet: 23,
  smtp: 25,
  dns: 53,
  dhcp: 67,
  tftp: 69,
}
