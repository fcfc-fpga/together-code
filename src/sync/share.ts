import type { QuickPickItem } from 'vscode'
import { customAlphabet } from 'nanoid'
import { ConfigurationTarget, env, ThemeIcon, Uri, window, workspace } from 'vscode'
import { configs } from '../configs'
import { CustomUriScheme } from '../fs/provider'
import { useUsers } from '../ui/users'

export interface ConnectionConfig {
  type: 'ws' | 'wss' | 'trystero'
  domain: string
  roomId: string
  workspace: number
  host?: {
    hostname: string
    port: number
  } | undefined
}

export function makeTrackUri(config: ConnectionConfig, uri_: Uri) {
  const folder = getWorkspaceFolderByUri(uri_)
  if (!folder || folder.uri.scheme !== uri_.scheme) {
    return null
  }
  const path = getRelativeWorkspacePath(folder.uri.path, uri_.path)
  if (path === null) {
    return null
  }

  let authority = `${config.type}.${config.roomId}.${config.domain}`
  if (folder.index !== 0)
    authority += `|${folder.index}`
  return Uri.from({
    scheme: CustomUriScheme,
    authority,
    path: path.startsWith('/') ? path : `/${path}`,
  })
}

function getWorkspaceFolderByUri(uri: Uri) {
  const uriString = uri.toString()
  const folders = workspace.workspaceFolders
    ?.filter((folder) => {
      if (folder.uri.scheme !== uri.scheme) {
        return false
      }
      const folderUri = trimTrailingSlash(folder.uri.toString())
      return uriString === folderUri || uriString.startsWith(`${folderUri}/`)
    })
    .sort((a, b) => b.uri.toString().length - a.uri.toString().length)

  return folders?.[0] ?? workspace.getWorkspaceFolder(uri)
}

function trimTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

export function parseTrackUri(uri: Uri): ConnectionConfig & { path: string } | null {
  if (uri.scheme !== CustomUriScheme) {
    return null
  }
  const [typeAndRoomId, folderIndex] = uri.authority.split('|', 2)
  const [type, roomId, ...domainParts] = typeAndRoomId.split('.')
  const domain = domainParts.join('.')
  if (!type || !roomId || !domain) {
    return null
  }
  if (type !== 'ws' && type !== 'wss' && type !== 'trystero') {
    return null
  }
  return {
    path: normalizeTrackPath(uri.path),
    type,
    roomId,
    domain,
    workspace: +folderIndex || 0,
  }
}

function getRelativeWorkspacePath(folderPath: string, targetPath: string) {
  const basePath = folderPath.length > 1 && folderPath.endsWith('/')
    ? folderPath.slice(0, -1)
    : folderPath
  if (targetPath === basePath) {
    return ''
  }
  if (basePath === '/') {
    return targetPath
  }
  if (!targetPath.startsWith(`${basePath}/`)) {
    return null
  }
  return targetPath.slice(basePath.length)
}

function normalizeTrackPath(path: string) {
  try {
    return decodeURIComponent(path)
  }
  catch {
    return path
  }
}

export async function inquireHostConfig(): Promise<ConnectionConfig | null> {
  const { inquireUserName } = useUsers()
  const [server, _] = await Promise.all([
    inquireServer(),
    inquireUserName(true),
  ])
  if (!server) {
    return null
  }

  if (!workspace.workspaceFolders?.length) {
    window.showErrorMessage('当前没有打开任何工作区文件夹。')
    return null
  }
  let folderIndex = 0
  if (workspace.workspaceFolders.length > 1) {
    const pick = await window.showQuickPick(
      workspace.workspaceFolders.map(f => ({
        label: f.name,
        description: f.uri.toString(),
        folderIndex: f.index,
      })),
      {
        placeHolder: '选择要共享的工作区文件夹',
      },
    )
    if (!pick) {
      return null
    }
    folderIndex = pick.folderIndex
  }

  return {
    ...server,
    roomId: generateRoomId(folderIndex),
    workspace: folderIndex,
  }
}

async function inquireServer() {
  let servers = [...configs.servers]
  const updateServers = (newServers: string[]) => {
    servers = newServers
    configs.update('servers', newServers, ConfigurationTarget.Global)
  }

  const quickPick = window.createQuickPick()
  quickPick.title = '选择中继方式，或输入自定义 WebSocket 服务器地址'
  quickPick.placeholder = '输入 WebSocket 服务器地址（wss://），或选择 Trystero 策略'
  quickPick.value = ''
  let allItems = quickPick.items = [
    ...servers.map(s => ({
      label: s,
      description: '已保存的服务器',
      buttons: [{
        iconPath: new ThemeIcon('trash'),
        tooltip: '删除服务器',
      }],
    })),
    { label: 'trystero:mqtt', description: '使用 MQTT 策略的 Trystero' },
    { label: 'trystero:nostr', description: '使用 Nostr 策略的 Trystero' },
    { label: '本机共享', description: '通过本地网络共享' },
  ]
  quickPick.onDidChangeValue((value) => {
    if (value.startsWith('ws://') || value.startsWith('wss://') || 'ws://'.startsWith(value) || 'wss://'.startsWith(value)) {
      if (!allItems.find(i => i.label === value)) {
        quickPick.items = [{ label: value, description: '自定义服务器' }, ...allItems]
        return
      }
    }
    quickPick.items = allItems
  })
  quickPick.onDidTriggerItemButton((e) => {
    const { label } = e.item
    if (e.button.tooltip === '删除服务器') {
      updateServers(servers.filter(s => s !== label))
      allItems = allItems.filter(i => i.label !== label)
      quickPick.items = quickPick.items.filter(i => i.label !== label)
    }
  })
  const result = await new Promise<string | undefined>((resolve) => {
    quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]?.label || quickPick.value || undefined))
    quickPick.onDidHide(() => resolve(undefined))
    quickPick.show()
  })
  quickPick.dispose()

  if (!result) {
    return null
  }
  if (result.startsWith('trystero:')) {
    const strategy = result.slice('trystero:'.length)
    if (strategy !== 'nostr' && strategy !== 'mqtt') {
      window.showErrorMessage('无效的 Trystero 策略。')
      return null
    }
    return {
      type: 'trystero' as const,
      domain: strategy,
    }
  }
  if (import.meta.env.TARGET === 'node' && result === '本机共享') {
    const host = await inquireHostname()
    if (!host) {
      return null
    }
    const port = await (await import('get-port')).default({ host })
    return {
      type: 'ws' as const,
      domain: `${host.includes(':') ? `[${host}]` : host}:${port}`,
      host: {
        hostname: host,
        port,
      },
    }
  }
  if (!result.startsWith('ws://') && !result.startsWith('wss://')) {
    window.showErrorMessage('无效的 WebSocket 服务器地址。')
    return null
  }
  const url = new URL(result)
  if (url.pathname !== '/' || url.search || url.hash) {
    window.showErrorMessage('WebSocket 服务器地址不能包含路径、查询参数或哈希。')
    return null
  }
  updateServers([
    result,
    ...servers.filter(s => s !== result),
  ])
  return {
    type: url.protocol === 'wss:' ? 'wss' as const : 'ws' as const,
    domain: url.host,
  }
}

async function inquireHostname() {
  const os = await import('node:os')
  const interfaces = os.networkInterfaces()

  const items: QuickPickItem[] = []
  for (const ifaceName in interfaces) {
    const ifaceAddresses = interfaces[ifaceName]
    if (!ifaceAddresses)
      continue
    for (const addrInfo of ifaceAddresses) {
      if (addrInfo.address.startsWith('fe80::')) {
        continue
      }
      items.push({
        label: addrInfo.address,
        description: `网卡：${ifaceName} (${addrInfo.family}${addrInfo.internal ? '，内部' : ''})`,
      })
    }
  }

  const countColons = (addr: string) => (addr.match(/:/g) || []).length
  items.sort((a, b) => countColons(a.label) - countColons(b.label))

  const result = await window.showQuickPick(items, {
    placeHolder: '选择用于共享的主机地址',
  })

  return result?.label || null
}

const roomIdNanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 6)
const folderToRoomId = new Map<string, string>()

function generateRoomId(folderIndex: number) {
  if (import.meta.env.NODE_ENV === 'development') {
    return 'testtest'
  }
  const folderUri = workspace.workspaceFolders![folderIndex].uri.toString()
  const existing = folderToRoomId.get(folderUri)
  if (existing) {
    return existing
  }
  const originalName = workspace.workspaceFolders![folderIndex].name || workspace.name || 'unknown'
  const normalizedName = originalName.split(/[^a-z0-9]+/i).filter(Boolean).join('-').toLowerCase()
  const roomId = `${normalizedName}-${roomIdNanoid()}`
  folderToRoomId.set(folderUri, roomId)
  return roomId
}

export async function copyShareLink(config: ConnectionConfig, isHosting = false) {
  const shareLink = makeTrackUri(config, workspace.workspaceFolders![config.workspace].uri)!.toString()
  while (true) {
    env.clipboard.writeText(decodeURIComponent(shareLink))
    const res = await window.showInformationMessage(`${isHosting ? '已开始共享当前会话。' : ''}已将邀请链接复制到剪贴板。

他人可点击“加入会话”并粘贴此链接，加入当前会话。`, '再次复制')
    isHosting = false
    if (res !== '再次复制') {
      break
    }
  }
}

export function validateShareLink(value: string) {
  if (!value.trim().startsWith(`${CustomUriScheme}://`)) {
    return `邀请链接必须以 ${CustomUriScheme}:// 开头`
  }
  try {
    const parsed = parseTrackUri(Uri.parse(value.trim()))
    if (parsed) {
      return null
    }
  }
  catch {}
  return '邀请链接无效。有效链接示例：together-code://ws.room.domain:port/ 或 together-code://trystero.room.mqtt/'
}
