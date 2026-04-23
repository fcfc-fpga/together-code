import { defineService, useVscodeContext } from 'reactive-vscode'

export const useTunnelsTree = defineService(() => {
  useVscodeContext('together-code:supportsTunnels', false)
})
