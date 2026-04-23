import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { window } from 'vscode'
import { getAppRoot } from '../utils.js'

export function resolveAsset(path: string) {
  const appRoot = getAppRoot()
  const resolved = resolve(appRoot, '../node_modules', path)
  if (!existsSync(resolved)) {
    window.showErrorMessage(`找不到资源：${path}`)
    throw new Error(`找不到资源：${path}`)
  }
  return resolved
}
