import type * as Y from 'yjs'
import type { Connection } from '../sync/connection'
import type { Ref } from 'reactive-vscode'
import { nanoid } from 'nanoid'
import { computed, defineService, extensionContext, onScopeDispose, ref, watch } from 'reactive-vscode'
import { authentication, ConfigurationTarget, window } from 'vscode'
import { configs } from '../configs'
import { useActiveSession } from '../session'
import { useObserverDeep } from '../sync/doc'
import { createColorAllocator, LoadingColor } from './colors'

export interface UserColor {
  id: string
  fg: string
  bg: string
}

export interface UserInfo {
  name: string
  avatarUrl: string | null
  color: UserColor | null
}

export interface CurrentUserHandle {
  gracefulLeave: () => Promise<void>
}

export interface UsersService {
  knownPeerIds: Ref<string[]>
  departedPeerIds: Ref<string[]>
  peers: Ref<string[] | undefined>
  userIdentity: Ref<string | null>
  userName: Ref<string | null>
  inquireUserIdentity: () => Promise<string | null>
  inquireUserName: (isHost: boolean) => Promise<string | null>
  getUserInfo: (peerId: string) => {
    name: string
    avatarUrl: string | null
    color: UserColor
  }
  pickPeerId: () => Promise<string | undefined>
  useCurrentUser: (connection: Connection, doc: Y.Doc) => CurrentUserHandle
}

export const useUsers = defineService((): UsersService => {
  const UserIdentityStateKey = 'together-code.userIdentity'
  const { role, doc, selfId, peers, state } = useActiveSession()

  const map = computed(() => doc.value?.getMap<UserInfo>('users'))
  const knownPeerIds = computed(() => map.value ? Array.from(map.value.keys()) : [])
  const departedPeerIds = ref<string[]>([])
  const lastKnownUsers = new Map<string, UserInfo>()

  const colorAllocator = createColorAllocator()
  const userName = ref<string | null>(null)
  const userIdentity = ref<string | null>(null)
  const avatarUrl = ref<string | null>(null)

  function markPeerDeparted(peerId: string) {
    if (!departedPeerIds.value.includes(peerId)) {
      departedPeerIds.value = [...departedPeerIds.value, peerId]
    }
  }

  function clearPeerDeparted(peerId: string) {
    if (departedPeerIds.value.includes(peerId)) {
      departedPeerIds.value = departedPeerIds.value.filter(id => id !== peerId)
    }
  }

  const mapVersion = useObserverDeep(map, (event, map) => {
    for (const [peerId, { action, oldValue }] of event.keys) {
      if (action === 'add') {
        const user = map.get(peerId) as UserInfo

        if (role.value === 'host') {
          map.set(peerId, {
            ...user,
            color: colorAllocator.alloc(peerId),
          })
        }

        const currentUser = map.get(peerId) as UserInfo | undefined
        if (currentUser) {
          lastKnownUsers.set(peerId, currentUser)
        }
        clearPeerDeparted(peerId)

        if (peerId !== selfId.value) {
          window.showInformationMessage(`${user.name} 已加入会话。`)
        }
      }
      else if (action === 'update') {
        const user = map.get(peerId) as UserInfo | undefined
        if (user) {
          lastKnownUsers.set(peerId, user)
        }
        clearPeerDeparted(peerId)
      }
      else if (action === 'delete') {
        if (role.value === 'host') {
          colorAllocator.free(peerId)
        }
        if (peerId !== selfId.value) {
          markPeerDeparted(peerId)
        }

        if (peerId !== selfId.value && state.value) {
          window.showInformationMessage(`${oldValue.name} 已离开会话。`)
        }
      }
    }
  }, (map) => {
    if (role.value === 'host') {
      for (const [peerId, user] of map.entries()) {
        map.set(peerId, {
          ...user,
          color: colorAllocator.alloc(peerId),
        })
      }
    }

    for (const [peerId, user] of map.entries()) {
      lastKnownUsers.set(peerId, user)
      clearPeerDeparted(peerId)
    }
  })

  async function inquireUserName(isHost: boolean) {
    return userName.value = await worker()
    async function worker() {
      if (configs.userName) {
        return configs.userName
      }
      if (userName.value) {
        return userName.value
      }

      const occupied = new Set(map.value?.keys())
      function toFreeName(name: string) {
        let result = name
        for (let i = 1; occupied.has(result); i++) {
          result = `${name} ${i}`
        }
        return result
      }

      const providers = ['github', 'microsoft']
      for (const providerId of providers) {
        const accounts = await authentication.getAccounts?.(providerId)
        if (accounts.length > 0) {
          if (!avatarUrl.value && providerId === 'github') {
            avatarUrl.value = `https://github.com/${accounts[0].id}.png?size=128`
          }
          return toFreeName(accounts[0].label)
        }
      }

      if (isHost) {
        return '主机'
      }

      const newName = await window.showInputBox({
        prompt: '输入你的名称',
        placeHolder: '你的名称',
        value: toFreeName('访客'),
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (occupied.has(value)) {
            return '该名称已被占用，请选择其他名称。'
          }
          if (value.length === 0) {
            return '名称不能为空。'
          }
          if (value.length > 16) {
            return '名称过长。'
          }
          return null
        },
      })
      if (newName === undefined) {
        return null
      }
      configs.update('userName', newName, ConfigurationTarget.Global)
      return newName
    }
  }

  async function inquireUserIdentity() {
    if (userIdentity.value) {
      return userIdentity.value
    }
    const context = extensionContext.value
    if (!context) {
      throw new Error('扩展上下文尚未准备就绪。')
    }
    const stored = context.globalState.get<string>(UserIdentityStateKey)
    if (stored) {
      userIdentity.value = stored
      return stored
    }
    const created = nanoid()
    userIdentity.value = created
    await context.globalState.update(UserIdentityStateKey, created)
    return created
  }

  function getUserInfo(peerId: string) {
    void mapVersion.value
    const user = map.value?.get(peerId) ?? lastKnownUsers.get(peerId)
    return {
      name: user?.name || '未知',
      avatarUrl: user?.avatarUrl || null,
      color: user?.color || LoadingColor,
    }
  }

  // Cleanup clients when disconnected
  watch(peers, (peers) => {
    if (!map.value || state.value?.role !== 'host' || !peers) {
      return
    }
    for (const peerId of map.value.keys()) {
      if (peerId !== selfId.value && !peers.includes(peerId)) {
        map.value.delete(peerId)
      }
    }

    for (const peerId of lastKnownUsers.keys()) {
      if (peerId !== selfId.value && !peers.includes(peerId) && !map.value.has(peerId)) {
        lastKnownUsers.delete(peerId)
        clearPeerDeparted(peerId)
      }
    }
  })

  async function pickPeerId() {
    if (!peers.value?.length) {
      return undefined
    }
    const result = await window.showQuickPick<{
      peerId: string
      label: string
      picked: boolean
      alwaysShow: true
    }>(
      peers.value
        .filter(peerId => peerId !== selfId.value)
        .map((peerId) => {
          const user = getUserInfo(peerId)
          return {
            peerId,
            label: user.name,
            picked: false,
            alwaysShow: true,
          }
        }),
    )
    return result?.peerId
  }

  function useCurrentUser(connection: Connection, doc: Y.Doc) {
    if (!userName.value) {
      throw new Error('用户名尚未设置。')
    }
    const map = doc.getMap<UserInfo>('users')
    const [sendLeave, recvLeave] = connection.makeAction<null>('usrLeave')

    function removeUser(peerId: string) {
      if (map.has(peerId)) {
        map.delete(peerId)
      }
    }

    recvLeave((_data, peerId) => {
      removeUser(peerId)
    })

    map.set(connection.selfId, {
      name: userName.value,
      avatarUrl: avatarUrl.value,
      color: null,
    })
    async function gracefulLeave() {
      removeUser(connection.selfId)
      try {
        await sendLeave(null)
      }
      catch {
        // Ignore transport shutdown races during manual leave.
      }
      await new Promise(resolve => setTimeout(resolve, 80))
    }
    onScopeDispose(() => {
      removeUser(connection.selfId)
    })
    return {
      gracefulLeave,
    }
  }

  return {
    knownPeerIds,
    departedPeerIds,
    peers,
    userIdentity,
    userName,
    inquireUserIdentity,
    inquireUserName,
    getUserInfo,
    pickPeerId,
    useCurrentUser,
  }
})
