import { defineService, useCommands } from 'reactive-vscode'
import { commands, window } from 'vscode'
import { undoManagers } from '../fs/common'

export const useCollaborativeUndo = defineService(() => {
  useCommands({
    'together-code.undo': () => {
      const uri = window.activeTextEditor?.document.uri.toString()
      const undoManager = uri ? undoManagers.get(uri) : undefined
      if (undoManager) {
        undoManager.undo()
      }
      else {
        commands.executeCommand('undo')
      }
    },
    'together-code.redo': () => {
      const uri = window.activeTextEditor?.document.uri.toString()
      const undoManager = uri ? undoManagers.get(uri) : undefined
      if (undoManager) {
        undoManager.redo()
      }
      else {
        commands.executeCommand('redo')
      }
    },
  })
})
