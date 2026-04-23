import type { TreeViewNode } from 'reactive-vscode'
import { computed, defineService, ref, useTreeView } from 'reactive-vscode'
import { ThemeColor, ThemeIcon, Uri } from 'vscode'
import { useActiveSession } from '../session'
import { useSelections } from './selections'
import { useUsers } from './users'

export const useParticipantsTree = defineService(() => {
  const { peers, getUserInfo, departedPeerIds } = useUsers()
  const { getSelection } = useSelections()
  const { toLocalUri, hostId, connection } = useActiveSession()

  const pings = ref<Record<string, number>>({})
  setInterval(() => {
    if (!peers.value || !connection.value) {
      pings.value = {}
      return
    }
    for (const peerId of peers.value) {
      connection.value.ping(peerId).then((time) => {
        pings.value[peerId] = time
      })
    }
  }, 5000)

  const orderedPeers = computed(() => {
    const hiddenPeerIds = new Set(departedPeerIds.value)
    return (peers.value || [])
      .filter(peerId => peerId === hostId.value || !hiddenPeerIds.has(peerId))
      .slice()
      .sort((a, b) => {
      if (a === hostId.value)
        return -1
      if (b === hostId.value)
        return 1
      return getUserInfo(a).name.localeCompare(getUserInfo(b).name)
      })
  })

  useTreeView(
    'together-code.participants',
    computed(() => orderedPeers.value.map<TreeViewNode>((peerId) => {
      const user = getUserInfo(peerId)
      const selections = getSelection(peerId)

      let tooltip = user.name
      if (selections) {
        const path = toLocalUri(Uri.parse(selections.uri)).fsPath
        const line = selections.fallbackSelections[0]?.[3]
        tooltip += line === undefined ? ` • ${path}` : ` • ${path}:${line + 1}`
      }

      let description = `${pings.value[peerId] ?? '-'}ms `
      if (peerId === hostId.value) {
        description += '（主机）'
      }

      return {
        treeItem: {
          iconPath: new ThemeIcon('circle', new ThemeColor(user.color.id)),
          label: user?.name ?? '未知',
          description,
          tooltip,
          contextValue: 'jumpable',
          command: {
            title: '跳转到成员位置',
            command: 'together-code.jumpToParticipant',
            arguments: [peerId],
          },
          peerId,
        },
      }
    })),
  )
})
