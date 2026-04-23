import type { BirpcReturn } from 'birpc'
import type { Command, SourceControlResourceDecorations, SourceControlResourceGroup, SourceControlResourceState, TextDocumentShowOptions } from 'vscode'
import type * as Y from 'yjs'
import type { GuestFunctions, HostFunctions } from '../rpc/types'
import type { GitExtension } from './git'
import type { ScmChange, ScmGroupMeta, ScmRepo } from './types'
import { basename } from 'pathe'
import { useCommands, useDisposable, watchEffect } from 'reactive-vscode'
import { extensions, l10n, scm, ThemeColor, Uri, ViewColumn, window, workspace } from 'vscode'
import { CustomUriScheme } from '../fs/provider'
import { useShallowYArray, useShallowYMapValueScopes } from '../sync/doc'
import { lazy } from '../utils'
import { Status } from './git'

export function useGuestScm(doc: Y.Doc, _rpc: BirpcReturn<HostFunctions, GuestFunctions>) {
  return

  const map = doc.getMap<ScmRepo>('scm')

  useShallowYMapValueScopes(() => map, useScmRepo)

  useCommands({
    'together-code.scm.openFile': async (resource, ...additionalResources) => {
      let urisToOpen = []
      if (resource) {
        if (resource instanceof Uri) {
          switch (resource.scheme) {
            case CustomUriScheme:
              urisToOpen = [resource]
              break
            case 'vsls-scc':{
              const queryData = JSON.parse(resource.query)
              if (queryData.resourceUri) {
                urisToOpen = [Uri.parse(queryData.resourceUri)]
              }
              break
            }
          }
        }
        else {
          if (!(resource instanceof ScmResourceState)) {
            return
          }

          if (resource) {
            urisToOpen = [resource, ...additionalResources]
              .filter(
                state =>
                  state.changeType !== Status.DELETED
                  && state.changeType !== Status.INDEX_DELETED,
              )
              .map(state => state.resourceUri)
          }
        }
      }
      else {
        // urisToOpen = this.getSccResources().map(state => state.resourceUri)
      }

      if (!urisToOpen || !urisToOpen.length) {
        return
      }

      const activeEditor = window.activeTextEditor

      for (const uri of urisToOpen) {
        const openOptions: TextDocumentShowOptions = {
          preserveFocus: resource instanceof ScmResourceState,
          preview: false,
          viewColumn: ViewColumn.Active,
        }

        const document = await workspace.openTextDocument(uri)

        if (activeEditor && activeEditor.document.uri.toString() === uri.toString()) {
          openOptions.selection = activeEditor.selection
          const visibleRanges = activeEditor.visibleRanges;
          (await window.showTextDocument(document, openOptions)).revealRange(visibleRanges[0])
        }
        else {
          await window.showTextDocument(document, openOptions)
        }
      }
    },
    'together-code.scm.cleanAll': async (group: SourceControlResourceGroup) => {
      const states = group.resourceStates
        .filter(state => state instanceof ScmResourceState)
        .filter(({ groupMeta }) => groupMeta && groupMeta.supportsClean)
      if (!states.length) {
        return
      }

      const t = states.filter(({ status }) => status === Status.UNTRACKED).length
      let message
      let action = '放弃更改'

      if (states.length === 1) {
        if (t > 0) {
          message = `确定要删除 ${basename(states[0].resourceUri.fsPath)} 吗？`
          action = '删除文件'
        }
        else if (states[0].status === Status.DELETED) {
          action = '恢复文件'
          message = `确定要恢复 ${basename(states[0].resourceUri.fsPath)} 吗？`
        }
        else {
          message = `确定要放弃 ${basename(states[0].resourceUri.fsPath)} 中的更改吗？`
        }
      }
      else {
        if (states.every(({ status }) => status === Status.DELETED)) {
          action = '恢复文件'
          message = `确定要恢复这 ${states.length} 个文件吗？`
        }
        else {
          message = `确定要放弃这 ${states.length} 个文件中的更改吗？`
        }
        if (t > 0) {
          message = `${message}\n\n这将删除 ${t} 个未跟踪文件！`
        }
      }
      if ((await window.showWarningMessage(message, { modal: true }, action)) === action) {
        // await rpc.scmClean(
        //   states[0].repoUri,
        //   states[0].groupMeta.groupId,
        //   states.map(({ resourceUri }) => resourceUri.toString()),
        // )
      }
    },
    'together-code.scm.revertChange': async (..._args) => {
      // console.log('Revert change called', args)
    },
  })

  //   async function getDiscardUntrackedChangesDialogDetails(resources: SourceControlResourceState[]): Promise<[string, string, string]> {
  //     const isWindows = useActiveSession()!.hostMeta.value!.os === 'win32'
  //     const discardUntrackedChangesToTrash = await rpc.scmShouldDiscardUntrackedChangesToTrash()

  //     const messageWarning = !discardUntrackedChangesToTrash
  //       ? resources.length === 1
  //         ? `\n\n${l10n.t('This is IRREVERSIBLE!\nThis file will be FOREVER LOST if you proceed.')}`
  //         : `\n\n${l10n.t('This is IRREVERSIBLE!\nThese files will be FOREVER LOST if you proceed.')}`
  //       : ''

  //     const message = resources.length === 1
  //       ? l10n.t('Are you sure you want to DELETE the following untracked file: \'{0}\'?{1}', basename(resources[0].resourceUri.fsPath), messageWarning)
  //       : l10n.t('Are you sure you want to DELETE the {0} untracked files?{1}', resources.length, messageWarning)

  //     const messageDetail = discardUntrackedChangesToTrash
  //       ? isWindows
  //         ? resources.length === 1
  //           ? l10n.t('You can restore this file from the Recycle Bin.')
  //           : l10n.t('You can restore these files from the Recycle Bin.')
  //         : resources.length === 1
  //           ? l10n.t('You can restore this file from the Trash.')
  //           : l10n.t('You can restore these files from the Trash.')
  //       : ''

  //     const primaryAction = discardUntrackedChangesToTrash
  //       ? isWindows
  //         ? l10n.t('Move to Recycle Bin')
  //         : l10n.t('Move to Trash')
  //       : resources.length === 1
  //         ? l10n.t('Delete File')
  //         : l10n.t('Delete All {0} Files', resources.length)

//     return [message, messageDetail, primaryAction]
//   }
}

function useScmRepo(uri: string, repo: ScmRepo) {
  const [groups, meta] = repo.toArray()
  const sc = useDisposable(scm.createSourceControl('together-code-scm', meta.label, Uri.parse(meta.rootUri)))
  sc.inputBox.visible = false
  useShallowYMapValueScopes(
    () => groups,
    (id, data) => {
      const [changes, meta] = data.toArray()

      const group = useDisposable(sc.createResourceGroup(createGroupId(meta), l10n.t(meta.label)))
      group.hideWhenEmpty = meta.hideWhenEmpty

      const states = useShallowYArray(() => changes)
      watchEffect(() => {
        group.resourceStates = states.value.map(state => new ScmResourceState(state, meta, uri))
      })
    },
  )
  // sc.quickDiffProvider = {
  //   provideOriginalResource(uri, token) {

  //   },
  // }

  function createGroupId(meta: ScmGroupMeta) {
    let groupId = meta.groupId
    if (meta.supportsClean) {
      groupId += '(clean)'
    }
    if (meta.supportsOpenChanges) {
      groupId += '(openChanges)'
    }
    if (meta.supportsOpenFile) {
      groupId += '(openFile)'
    }
    return groupId
  }
}

class ScmResourceState implements SourceControlResourceState {
  public readonly resourceUri: Uri
  public readonly command: Command
  public readonly decorations: SourceControlResourceDecorations

  public readonly letter: string | undefined
  public readonly color: ThemeColor | undefined
  public readonly priority: number
  public readonly repoUri: string
  public readonly status: Status
  public readonly groupMeta: ScmGroupMeta

  constructor(change: ScmChange, meta: ScmGroupMeta, repoUri: string) {
    const { uri, status } = change
    const useIcons = !areGitDecorationsEnabled()

    this.status = status
    this.groupMeta = meta
    this.repoUri = repoUri

    this.resourceUri = Uri.parse(uri)
    this.command = {
      command: 'together-code.scm.openChange',
      title: '打开',
      arguments: [this.groupMeta.groupId, uri],
    }
    this.decorations = {
      strikeThrough: this.getStrikeThrough(),
      faded: false,
      tooltip: this.getTooltip(),
      light: useIcons
        ? { iconPath: this.getIconPath('light') }
        : undefined,
      dark: useIcons
        ? { iconPath: this.getIconPath('dark') }
        : undefined,
    }

    this.letter = this.getLetter()
    this.color = this.getColor()
    this.priority = this.getPriority()
  }

  private getIconPath(theme: 'light' | 'dark'): Uri | undefined {
    const Icons = getAllIcons()
    if (!Icons) {
      return undefined
    }
    switch (this.status) {
      case Status.INDEX_MODIFIED: return Icons[theme].Modified
      case Status.MODIFIED: return Icons[theme].Modified
      case Status.INDEX_ADDED: return Icons[theme].Added
      case Status.INDEX_DELETED: return Icons[theme].Deleted
      case Status.DELETED: return Icons[theme].Deleted
      case Status.INDEX_RENAMED: return Icons[theme].Renamed
      case Status.INDEX_COPIED: return Icons[theme].Copied
      case Status.UNTRACKED: return Icons[theme].Untracked
      case Status.IGNORED: return Icons[theme].Ignored
      case Status.INTENT_TO_ADD: return Icons[theme].Added
      case Status.INTENT_TO_RENAME: return Icons[theme].Renamed
      case Status.TYPE_CHANGED: return Icons[theme].TypeChanged
      case Status.BOTH_DELETED: return Icons[theme].Conflict
      case Status.ADDED_BY_US: return Icons[theme].Conflict
      case Status.DELETED_BY_THEM: return Icons[theme].Conflict
      case Status.ADDED_BY_THEM: return Icons[theme].Conflict
      case Status.DELETED_BY_US: return Icons[theme].Conflict
      case Status.BOTH_ADDED: return Icons[theme].Conflict
      case Status.BOTH_MODIFIED: return Icons[theme].Conflict
    }
  }

  private getPriority(): number {
    switch (this.status) {
      case Status.INDEX_MODIFIED:
      case Status.MODIFIED:
      case Status.INDEX_COPIED:
      case Status.TYPE_CHANGED:
        return 2
      case Status.IGNORED:
        return 3
      case Status.BOTH_DELETED:
      case Status.ADDED_BY_US:
      case Status.DELETED_BY_THEM:
      case Status.ADDED_BY_THEM:
      case Status.DELETED_BY_US:
      case Status.BOTH_ADDED:
      case Status.BOTH_MODIFIED:
        return 4
      default:
        return 1
    }
  }

  private getTooltip(): string {
    switch (this.status) {
      case Status.INDEX_MODIFIED: return l10n.t('索引已修改')
      case Status.MODIFIED: return l10n.t('已修改')
      case Status.INDEX_ADDED: return l10n.t('索引已添加')
      case Status.INDEX_DELETED: return l10n.t('索引已删除')
      case Status.DELETED: return l10n.t('已删除')
      case Status.INDEX_RENAMED: return l10n.t('索引已重命名')
      case Status.INDEX_COPIED: return l10n.t('索引已复制')
      case Status.UNTRACKED: return l10n.t('未跟踪')
      case Status.IGNORED: return l10n.t('已忽略')
      case Status.INTENT_TO_ADD: return l10n.t('待添加')
      case Status.INTENT_TO_RENAME: return l10n.t('待重命名')
      case Status.TYPE_CHANGED: return l10n.t('类型已更改')
      case Status.BOTH_DELETED: return l10n.t('冲突：双方都已删除')
      case Status.ADDED_BY_US: return l10n.t('冲突：由我们添加')
      case Status.DELETED_BY_THEM: return l10n.t('冲突：由对方删除')
      case Status.ADDED_BY_THEM: return l10n.t('冲突：由对方添加')
      case Status.DELETED_BY_US: return l10n.t('冲突：由我们删除')
      case Status.BOTH_ADDED: return l10n.t('冲突：双方都已添加')
      case Status.BOTH_MODIFIED: return l10n.t('冲突：双方都已修改')
      default: return ''
    }
  }

  private getLetter(): string | undefined {
    switch (this.status) {
      case Status.INDEX_MODIFIED:
      case Status.MODIFIED:
        return 'M'
      case Status.INDEX_ADDED:
      case Status.INTENT_TO_ADD:
        return 'A'
      case Status.INDEX_DELETED:
      case Status.DELETED:
        return 'D'
      case Status.INDEX_RENAMED:
      case Status.INTENT_TO_RENAME:
        return 'R'
      case Status.TYPE_CHANGED:
        return 'T'
      case Status.UNTRACKED:
        return 'U'
      case Status.IGNORED:
        return 'I'
      case Status.INDEX_COPIED:
        return 'C'
      case Status.BOTH_DELETED:
      case Status.ADDED_BY_US:
      case Status.DELETED_BY_THEM:
      case Status.ADDED_BY_THEM:
      case Status.DELETED_BY_US:
      case Status.BOTH_ADDED:
      case Status.BOTH_MODIFIED:
        return '!'
    }
  }

  private getColor(): ThemeColor | undefined {
    switch (this.status) {
      case Status.INDEX_MODIFIED:
        return new ThemeColor('gitDecoration.stageModifiedResourceForeground')
      case Status.MODIFIED:
      case Status.TYPE_CHANGED:
        return new ThemeColor('gitDecoration.modifiedResourceForeground')
      case Status.INDEX_DELETED:
        return new ThemeColor('gitDecoration.stageDeletedResourceForeground')
      case Status.DELETED:
        return new ThemeColor('gitDecoration.deletedResourceForeground')
      case Status.INDEX_ADDED:
      case Status.INTENT_TO_ADD:
        return new ThemeColor('gitDecoration.addedResourceForeground')
      case Status.INDEX_COPIED:
      case Status.INDEX_RENAMED:
      case Status.INTENT_TO_RENAME:
        return new ThemeColor('gitDecoration.renamedResourceForeground')
      case Status.UNTRACKED:
        return new ThemeColor('gitDecoration.untrackedResourceForeground')
      case Status.IGNORED:
        return new ThemeColor('gitDecoration.ignoredResourceForeground')
      case Status.BOTH_DELETED:
      case Status.ADDED_BY_US:
      case Status.DELETED_BY_THEM:
      case Status.ADDED_BY_THEM:
      case Status.DELETED_BY_US:
      case Status.BOTH_ADDED:
      case Status.BOTH_MODIFIED:
        return new ThemeColor('gitDecoration.conflictingResourceForeground')
    }
  }

  private getStrikeThrough(): boolean {
    switch (this.status) {
      case Status.DELETED:
      case Status.BOTH_DELETED:
      case Status.DELETED_BY_THEM:
      case Status.DELETED_BY_US:
      case Status.INDEX_DELETED:
        return true
      default:
        return false
    }
  }
}

const areGitDecorationsEnabled = lazy(() => {
  return workspace
    .getConfiguration('git')
    .get('decorations.enabled', true)
})

const getAllIcons = lazy(() => {
  const gitExtension = extensions.getExtension<GitExtension>('git')
  if (!gitExtension) {
    return null
  }
  const iconsRootPath = Uri.joinPath(gitExtension.extensionUri, 'resources', 'icons')
  function getIconUri(iconName: string, theme: string): Uri {
    return Uri.joinPath(iconsRootPath, theme, `${iconName}.svg`)
  }

  return {
    light: {
      Modified: getIconUri('status-modified', 'light'),
      Added: getIconUri('status-added', 'light'),
      Deleted: getIconUri('status-deleted', 'light'),
      Renamed: getIconUri('status-renamed', 'light'),
      Copied: getIconUri('status-copied', 'light'),
      Untracked: getIconUri('status-untracked', 'light'),
      Ignored: getIconUri('status-ignored', 'light'),
      Conflict: getIconUri('status-conflict', 'light'),
      TypeChanged: getIconUri('status-type-changed', 'light'),
    },
    dark: {
      Modified: getIconUri('status-modified', 'dark'),
      Added: getIconUri('status-added', 'dark'),
      Deleted: getIconUri('status-deleted', 'dark'),
      Renamed: getIconUri('status-renamed', 'dark'),
      Copied: getIconUri('status-copied', 'dark'),
      Untracked: getIconUri('status-untracked', 'dark'),
      Ignored: getIconUri('status-ignored', 'dark'),
      Conflict: getIconUri('status-conflict', 'dark'),
      TypeChanged: getIconUri('status-type-changed', 'dark'),
    },
  }
})
