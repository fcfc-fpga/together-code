import { computed, defineService, useCommand, useTreeView } from 'reactive-vscode'
import { ThemeIcon, window } from 'vscode'
import { useActiveSession } from '../session'
import { extractTerminalId } from '../terminal/common'

export const useTerminalsTree = defineService(() => {
  const { shadowTerminals } = useActiveSession()

  const sortedTerminals = computed<any[]>(() => {
    if (!shadowTerminals.value) {
      return []
    }
    return Array.from((shadowTerminals.value as Map<string, any>).values())
      .sort((a: any, b: any) => a.createdAt - b.createdAt)
  })

  useCommand('together-code.focusSharedTerminal', (terminalId: string) => {
    const terminal = terminalId && window.terminals.find(t => extractTerminalId(t) === terminalId)
    if (!terminal) {
      window.showWarningMessage('找不到共享终端。')
      return
    }
    terminal.show()
  })
  useCommand('together-code.closeSharedTerminal', (item?: any) => {
    const terminalId = item?.treeItem?.terminalId
    const terminal = terminalId ? shadowTerminals.value?.get(terminalId) : null
    if (!terminal) {
      window.showWarningMessage('找不到共享终端。')
      return
    }
    terminal.dispose()
  })

  useTreeView(
    'together-code.terminals',
    computed(() => sortedTerminals.value.map((terminal: any) => {
      return {
        treeItem: {
          iconPath: new ThemeIcon('terminal'),
          label: terminal.name,
          terminal,
          command: {
            title: '切换到共享终端',
            command: 'together-code.focusSharedTerminal',
            arguments: [terminal.id],
          },
          terminalId: terminal.id,
        },
      }
    })),
  )
})
