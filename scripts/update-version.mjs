import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJsonPath = join(root, 'package.json')
const versionPath = join(root, 'VERSION')

const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
const version = packageJson.version

if (!version || typeof version !== 'string') {
  throw new Error('package.json version is missing')
}

await writeFile(versionPath, `${version}\n`)
console.log(`VERSION updated to ${version}`)
