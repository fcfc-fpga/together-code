# Together Code 二次开发导览

本文档面向后续二次开发，重点说明这个 VS Code 扩展的代码结构、运行链路、核心抽象、可扩展位置和当前实现状态。

## 项目概览

这是一个基于 TypeScript 的 VS Code 扩展，目标是提供类似 Live Share 的实时协作能力。核心能力包括：

- 基于 WebRTC/Trystero 或 WebSocket 的会话连接。
- Host 共享本地工作区文件，Guest 通过虚拟文件系统访问。
- 基于 Yjs 的共享状态同步。
- 共享终端。
- 端口转发。
- 远程语言服务代理。
- 诊断信息同步。
- 文本选区同步与参与者 UI。
- Webview 聊天面板。

入口文件是 `src/extension.ts`。它不直接实现业务，而是装配各个服务：

```ts
useActiveSession()
useWebview()
useFsProvider()
useSelections()
useParticipantsTree()
useTerminalsTree()
useTunnelsTree()
```

扩展依赖 `reactive-vscode` 管理 VS Code 生命周期、命令、TreeView、Webview、配置和响应式状态。

## 构建与运行

项目使用 `pnpm` 和 `tsdown`。

常用脚本在 `package.json`：

- `pnpm run dev`：监听构建扩展、Webview 和浏览器目标。
- `pnpm run build`：生产构建。
- `pnpm run typecheck`：TypeScript 类型检查。
- `pnpm run lint`：ESLint。
- `pnpm run browser`：通过 `vscode-test-web` 启动 Web 版扩展调试。
- `pnpm run wsserver`：启动本地 WebSocket 中继服务开发模式。

构建配置在 `tsdown.config.ts`，有三个输出目标：

- Node 扩展目标：入口 `src/extension.ts`，输出 `dist/extension.cjs`。
- Browser 扩展目标：入口 `src/extension.ts`，输出 `dist/browser.js`。
- Webview 目标：入口 `src/webview/main.tsx`，输出 `dist/webview.mjs` 和 `dist/webview.css`。

Browser 目标会替换一批 Node-only 模块为 stub：

- `src/session/host.ts` -> `src/session/host.stub.ts`
- `src/tunnel/index.ts` -> `src/tunnel/index.stub.ts`
- `src/ui/tunnels.ts` -> `src/ui/tunnels.stub.ts`
- `src/sync/ws/host.ts` -> `src/sync/ws/host.stub.ts`

这意味着二次开发时要明确功能是否需要支持 VS Code Web。涉及本地进程、终端、TCP、Node API 的能力通常只能在桌面端启用。

## 顶层目录

```text
assets/                 扩展图标、截图、辅助脚本
docs/                   二次开发文档
src/
  extension.ts          VS Code 扩展入口
  configs.ts            扩展配置封装
  utils.ts              通用工具
  session/              Host/Guest 会话生命周期
  sync/                 底层连接、Yjs 文档同步、邀请链接、WebSocket 服务
  rpc/                  Host/Guest RPC 封装
  fs/                   远程文件系统与文本编辑同步
  terminal/             共享终端与 PTY 适配
  tunnel/               端口转发
  ls/                   远程语言服务代理
  diagnostics/          诊断同步
  scm/                  源代码管理同步草稿
  ui/                   VS Code 侧 TreeView、选区、用户状态
  webview/              Webview UI、Trystero 运行环境、聊天
```

## 会话生命周期

会话入口在 `src/session/index.ts`。

`useActiveSession()` 维护当前会话状态：

- `state`：当前 Host 或 Guest session。
- `role`：`host` 或 `guest`。
- `doc`：当前 Yjs 文档。
- `connection`：统一连接抽象。
- `host()`：创建 Host 会话。
- `join()`：加入会话。
- `leave()`：离开或停止会话。
- `toTrackUri()` / `toLocalUri()`：Host 本地 URI 与协作 URI 的转换。

Host 创建流程在 `src/session/host.ts`：

1. 创建 effect scope。
2. 调用 `useConnection(config)` 建立底层连接。
3. 创建新的 `Y.Doc`。
4. 启用 `useDocSync(connection, doc)`。
5. 监听新 peer，发送 `init` 消息，包含 Yjs 初始状态和 Host 元信息。
6. 初始化 Host 侧业务模块：
   - `useHostFs`
   - `useHostTerminals`
   - `useHostScm`
   - `useHostRpc`
   - `useHostLs`
   - `useHostDiagnostics`
   - `useTunnels`
   - `useWebview().useChat`
   - `useUsers().useCurrentUser`

Guest 加入流程在 `src/session/guest.ts`：

1. 创建连接。
2. 等待 Host 的 `init` 消息。
3. 检查协议版本兼容性。
4. 创建 `Y.Doc`，启用文档同步并应用 Host 初始状态。
5. 初始化 Guest 侧业务模块：
   - `useGuestRpc`
   - `useGuestFs`
   - `useGuestTerminals`
   - `useGuestLs`
   - `useGuestDiagnostics`
   - `useGuestScm`
   - `useTunnels`
   - `useWebview().useChat`
   - `useUsers().useCurrentUser`
6. 监听 Host 是否断开，断开后触发重连提示。

二次开发新增会话级能力时，通常需要同时改 `createHostSession()` 和 `createGuestSession()`，确保 Host/Guest 两端都注册对应模块。

## 通信层

通信统一入口是 `src/sync/connection.ts` 的 `useConnection(config)`。

底层有两类连接：

- WebSocket：`src/sync/ws/guest.ts` 和 `src/sync/ws/host.ts`
- Trystero/WebRTC：`src/sync/trystero/index.ts`

上层业务不直接关心底层连接类型，而是使用：

```ts
const [send, recv] = connection.makeAction<TData, TMeta>('action')
```

`makeAction()` 做了几件事：

- 注册业务 action。
- 发送 JSON 或 `Uint8Array` 数据。
- 分发收到的消息。
- 统一处理 ping/pong 和 peer 列表。

Trystero 的 action 名称在开发环境会检查长度，不能超过 12 字节。新增 action 时建议使用短名称，例如 `chat`、`texts`、`terminal`。

当前主要 action：

- `init`：Guest 加入时接收 Host 初始 Yjs 状态。
- `doc`：同步整个 Yjs 文档更新。
- `rpc`：Host/Guest 的 birpc 调用通道。
- `texts`：打开文件后的文本增量同步。
- `textSave`：Host 保存文件后通知 Guest。
- `fsChange`：文件系统变更事件。
- `terminal`：终端输入输出。
- `tunnel`：端口转发 socket 数据。
- `t-link` / `t-unlink`：端口转发连接管理。
- `ls`：远程语言服务消息。
- `chat`：聊天消息。
- `__ping__` / `__pong__`：延迟检测。

Trystero 连接额外包了一层 `src/sync/trystero/controller.ts`，用于给消息加序号、ACK 和重发，保证普通业务消息按序应用。

## 邀请链接与 URI

邀请链接逻辑在 `src/sync/share.ts`。

协作 URI 使用自定义 scheme：

```text
together-code://<type>.<roomId>.<domain>|<workspaceIndex>/<path>
```

示例：

```text
together-code://trystero.my-room.mqtt/
together-code://wss.my-room.example.com/
```

关键函数：

- `inquireHostConfig()`：询问 Host 使用哪种连接方式。
- `makeTrackUri(config, uri)`：Host 本地 URI 转协作 URI。
- `parseTrackUri(uri)`：解析邀请链接。
- `copyShareLink(config)`：复制邀请链接。
- `validateShareLink(value)`：校验输入。

扩展连接策略或邀请链接格式时，需要先改这里，再改 `useConnection()` 的分发逻辑。

## Yjs 共享状态

全局共享状态由会话内的一个 `Y.Doc` 承载。文档同步在 `src/sync/doc.ts`：

- `useDocSync(connection, doc)`：监听 `doc.updateV2` 并通过 `doc` action 广播。
- `useObserverDeep()` / `useObserverShallow()`：把 Yjs 变化转换为 reactive-vscode 可观察状态。
- `useShallowYMap()` / `useShallowYArray()`：把 Yjs 容器映射为只读响应式数据。
- `useShallowYMapKeyScopes()` / `useShallowYMapValueScopes()`：按 key/value 创建可自动销毁的 effect scope。

当前主要 Yjs map：

- `users`：参与者信息和颜色。
- `selections`：参与者当前选区。
- `terminals`：共享终端元数据。
- `tunnel`：共享服务信息。
- `diagnostics`：Host 诊断信息。
- `scm`：SCM 同步草稿，目前未启用。

新增多人共享状态时，优先考虑挂到 Yjs 文档中；新增“请求-响应”操作时，优先使用 RPC；新增高频流式数据时，优先使用独立 action。

## RPC 层

RPC 在 `src/rpc/`，使用 `birpc` 和 `msgpackr`。

- `src/rpc/host.ts`：Host 暴露函数给 Guest 调用。
- `src/rpc/guest.ts`：Guest 创建指向 Host 的 RPC 客户端。
- `src/rpc/types.ts`：定义 Host/Guest 可调用函数类型。

`HostFunctions` 当前由这些模块的返回值拼接：

```ts
ReturnType<typeof useHostFs>
ReturnType<typeof useHostTerminals>
ReturnType<typeof useHostScm>
```

新增 Guest 调 Host 的能力时，可以让 Host 模块返回函数，并确保类型能被 `HostFunctions` 引用。新增 Host 调 Guest 的 RPC 则需要补充 `GuestFunctions`，当前项目基本没有使用这条方向。

## 文件系统与文本同步

文件系统模块在 `src/fs/`。

VS Code 侧注册自定义文件系统 provider 的位置是 `src/fs/provider.ts`：

- scheme 固定为 `together-code`。
- `useFsProvider()` 只允许一个 active provider。
- Guest 会话启动后通过 `useSetActiveProvider()` 接管所有 FS 操作。

Host 侧 `src/fs/host.ts`：

- 把 Guest 的 `stat/readDirectory/readFile/writeFile/delete/rename/watch` 等 FS 操作转发到 Host 本地 `workspace.fs`。
- 文件打开后为该文件创建独立 `Y.Doc`，用 `texts` action 同步文本增量。
- 监听 Host 本地保存和文件系统变化。

Guest 侧 `src/fs/guest.ts`：

- 实现 VS Code `FileSystemProvider`，把文件系统操作通过 RPC 发给 Host。
- 打开文本文件时调用 `trackContent()`，获取 Host 的初始文本 Yjs update。
- 本地编辑通过 `texts` action 发给 Host。
- 接收 Host 保存通知和文件变更事件。

重要细节：

- 文件内容编辑不是每次全量写文件，而是打开文件后通过 Yjs 文本增量同步。
- `editingUris` 用来避免本地应用远程变更时再次触发同步回环。
- 未打开文件仍然通过 RPC 全量读写。

## 共享终端

终端模块在 `src/terminal/`。

公共抽象在 `src/terminal/common.ts`：

- `TerminalData`：共享终端元数据。
- `useShadowTerminals()`：创建 VS Code ExtensionTerminal，作为共享终端的“影子终端”。
- `extractTerminalId()`：从 VS Code Terminal 提取共享终端 id。

Host 侧 `src/terminal/host.ts`：

- 使用 `src/terminal/pty/` 下的 PTY 适配创建真实进程。
- 把进程输出通过 `terminal` action 广播。
- 接收 Guest 输入并写入 PTY。
- 通过 Yjs map `terminals` 同步终端名称、可写状态、尺寸。
- 根据配置 `together-code.terminal.dimensionsSource` 计算最终 PTY 尺寸。

Guest 侧 `src/terminal/guest.ts`：

- 根据 Yjs `terminals` map 创建本地影子终端。
- 用户输入通过 `terminal` action 发给 Host。
- 终端尺寸变化通过 RPC 发给 Host。
- Guest 也可以请求 Host 创建新共享终端。

`src/terminal/pty/` 中不少代码来自 VS Code/PTY 适配，改动风险较高。除非要改底层终端行为，否则优先在 `host.ts`、`guest.ts`、`common.ts` 层扩展。

## 端口转发

端口转发模块在 `src/tunnel/`。

- `src/tunnel/types.ts`：socket 事件类型和共享服务元数据。
- `src/tunnel/index.ts`：组合 server/client，并维护 `t-link`、`t-unlink` action。
- `src/tunnel/server.ts`：共享本地 TCP 服务的一侧。
- `src/tunnel/client.ts`：在连接方本地创建 TCP server，并把 socket 数据转发给共享方。

共享服务元数据存储在 Yjs map `tunnel`：

```ts
interface ServerInfo {
  serverId: string
  peerId: string
  name: string
  host: string
  port: number
  createdAt: number
}
```

UI 在 `src/ui/tunnels.ts`：

- `shareServer`：输入本地端口或 URL，创建共享。
- `connectToSharedServer`：为远端共享服务分配本地端口并连接。
- `disconnectFromSharedServer`：断开本地连接。
- `copySharedServerLocalURL`：复制本地地址。

Browser 目标使用 stub，端口转发默认是桌面端能力。

## 远程语言服务

语言服务代理在 `src/ls/`。

设计思路：

- Guest 启动一个 `vscode-languageclient/browser` 的 LanguageClient。
- Host 为每个 Guest 创建一个 LSP connection。
- Guest 的 LSP 请求通过 `ls` action 转发到 Host。
- Host 调用 VS Code 内置命令，例如：
  - `vscode.executeHoverProvider`
  - `vscode.executeDefinitionProvider`
  - `vscode.executeCompletionItemProvider`
  - `vscode.executeFormatDocumentProvider`
  - `vscode.executeDocumentRenameProvider`
- Host 把结果转换为 LSP 协议对象返回 Guest。

URI 转换是这个模块的关键：

- Guest 请求里的 `together-code:` URI 要转换成 Host 本地 URI。
- Host 返回的位置要再转换成协作 URI。

新增语言能力时，通常在 `src/ls/host.ts` 增加对应 LSP handler，并使用 VS Code `vscode.execute*Provider` 命令桥接。

## 诊断同步

诊断模块在 `src/diagnostics/`。

Host 侧 `src/diagnostics/host.ts`：

- 读取 `languages.getDiagnostics()`。
- 监听 `languages.onDidChangeDiagnostics`。
- 将诊断转换为协议格式，写入 Yjs map `diagnostics`。

Guest 侧 `src/diagnostics/guest.ts`：

- 观察 Yjs map `diagnostics`。
- 为不同 source 创建 VS Code `DiagnosticCollection`。
- 把 Host 的诊断显示在 Guest 的虚拟文件上。

## 选区、用户和参与者 UI

用户模块在 `src/ui/users.ts`：

- 负责用户名称、头像、颜色。
- Host 给参与者分配颜色。
- 监听参与者加入/离开。
- 提供 `pickPeerId()` 和 `getUserInfo()`。

选区模块在 `src/ui/selections.ts`：

- 把本地活动编辑器和 selection 写入 Yjs map `selections`。
- 在本地可见编辑器上渲染远端选区和用户名标签。
- 支持 focus/follow participant。

参与者 TreeView 在 `src/ui/participants.ts`：

- 展示参与者列表、Host 标记、ping 延迟和 follow 状态。
- 点击参与者会跳到对应选区。

这几个模块是增加协作可视化能力的主要入口。

## Webview 与聊天

Webview 侧代码在 `src/webview/`。

扩展侧 `src/webview/index.ts`：

- 注册 `together-code.webview`。
- 生成 Webview HTML。
- 使用 birpc 和 Webview 通信。
- 让 Webview 承载 Trystero 连接能力。
- 管理聊天消息通道。
- 同步 UI 状态：`none`、`joining`、Host/Guest session state。

Webview 入口 `src/webview/main.tsx`：

- 创建 Vue app。
- 注册 Trystero `mqtt` 和 `nostr` 策略。
- 通过 `acquireVsCodeApi()` 和扩展侧通信。
- 根据 session state 渲染 `Welcome` 或 `Chat`。

聊天组件 `src/webview/components/Chat.tsx`：

- 支持文本消息。
- 支持粘贴/拖拽图片。
- 支持文件附件，图片和视频可内联预览，其他文件可下载。

二次开发 Webview UI 时要同步考虑：

- 扩展侧 `WebviewFunctions` / `ExtensionFunctions` 类型。
- Webview 侧 `rpc` 实现。
- `tsdown.config.ts` 的 webview 构建配置。
- `src/webview/styles.css`。

## WebSocket 中继服务

WebSocket 中继在 `src/sync/ws/`。

- `server.ts`：Node WebSocket 中继服务核心实现。
- `cli.ts`：命令行启动入口。
- `protocol.ts`：上行/下行消息序列化，支持 JSON 和二进制混合。
- `guest.ts`：普通 WebSocket 客户端连接。
- `host.ts`：Host Locally 模式，Host 本地起 WebSocket server。
- `go/`：Go 版本/部署相关文件。

服务 URL 路径格式：

```text
/<roomId>/<peerId>
```

服务端维护 room -> peer -> websocket 的映射，并通过 `__update_peers__` 通知房间内 peer 列表。

## SCM 当前状态

`src/scm/` 里有较多从 VS Code Git API 适配而来的实现草稿，但当前实际被禁用：

- `src/scm/host.ts` 的 `useHostScm()` 开头直接 `return {}`。
- `src/scm/guest.ts` 的 `useGuestScm()` 开头直接 `return`。

`package.json` 仍然贡献了 SCM 相关命令和菜单项，但运行时不会创建远程 SCM UI。

因此，SCM 是后续二次开发的一个明显候选方向，但需要先移除早退逻辑，再补齐 Host RPC、Guest 命令、diff/open/clean 等行为的闭环测试。

## 配置项

配置声明在 `package.json`，封装读取在 `src/configs.ts`。

当前配置：

- `together-code.servers`：自定义 WebSocket server 列表。
- `together-code.userName`：用户显示名。
- `together-code.trystero`：传给 `trystero.joinRoom` 的额外配置。
- `together-code.terminal.dimensionsSource`：共享终端尺寸来源，可选 `host`、`creator`、`minimum`、`maximum`。

新增配置时，需要同时改：

1. `package.json` 的 `contributes.configuration.properties`。
2. `src/configs.ts` 的类型定义。
3. 使用配置的业务模块。

## 常见二次开发入口

新增 VS Code 命令：

1. 在 `package.json` 的 `contributes.commands` 声明命令。
2. 需要菜单入口时，在 `contributes.menus` 增加条件。
3. 在对应模块使用 `useCommand()` 或 `useCommands()` 注册实现。
4. 如果命令依赖会话状态，复用 `together-code:inSession`、`together-code:isHost`、`together-code:isGuest` 等 context key。

新增共享状态：

1. 在 Host/Guest 都能访问的 session 模块中获取 `doc.getMap()` 或 `doc.getArray()`。
2. 使用 `src/sync/doc.ts` 的 observer helper 同步到 UI。
3. 对本地写入和远端写入做区分，避免回环。

新增 Guest 调 Host 操作：

1. 在 Host 侧模块返回 async 函数。
2. 确保函数类型进入 `HostFunctions`。
3. Guest 侧通过 `rpc.xxx()` 调用。
4. 对 VS Code `FileSystemError` 这类不可直接跨端抛出的错误，用结果包装或显式错误码。

新增实时数据通道：

1. 在 Host/Guest 都调用 `connection.makeAction()`。
2. 选一个 12 字节以内 action 名称。
3. 明确 payload 是 JSON 还是 `Uint8Array`。
4. 高频二进制数据要注意拷贝和背压，参考 `terminal`、`tunnel`。

新增 Webview 功能：

1. 扩展侧更新 `WebviewFunctions` 或 `ExtensionFunctions`。
2. Webview 侧实现对应 birpc 函数。
3. UI 组件放在 `src/webview/components/`。
4. 样式放到 `src/webview/styles.css` 或局部 inline style。

## 开发注意事项

- Host 与 Guest 通常需要成对修改。只改一侧很容易出现消息无人接收、RPC 类型不匹配或状态不同步。
- Trystero action 名称不能太长，开发环境会抛错。
- Yjs 更新带有 origin，已有代码用 `origin?.peerId` 和 `transaction.local` 防止回环，新增同步逻辑也要遵守。
- URI 转换非常关键。Host 本地 URI、Guest 虚拟 URI、LSP 协议 URI 混用时要明确方向。
- Node-only 能力要考虑 Browser 构建 stub，否则 Web 版构建可能失败。
- `src/terminal/pty/` 是底层适配层，优先避免大改。
- `src/scm/` 当前不是完整可用能力，开发前要按未完成功能看待。
- `__DEV__` 和 `import.meta.env.TARGET` 由 `tsdown.config.ts` 注入，排查构建差异时先看这里。

## 推荐改造顺序

如果要在这个项目上持续二次开发，建议按风险从低到高推进：

1. Webview/聊天增强：边界清晰，主要影响 `webview` 和 `chat` action。
2. 参与者与选区 UI 增强：主要影响 `ui/users.ts`、`ui/selections.ts`、`ui/participants.ts`。
3. 文件同步增强：影响核心协作体验，需要重点测试打开文件、保存、外部改动、重命名、删除。
4. 终端增强：涉及 PTY、尺寸、输入输出和跨平台问题。
5. 端口转发增强：涉及 TCP socket 生命周期和异常处理。
6. SCM 启用与补全：当前是草稿状态，工作量最大，需要系统补齐 Host/Guest/RPC/UI 闭环。

## 快速定位表

| 需求 | 优先查看文件 |
| --- | --- |
| 扩展激活与服务装配 | `src/extension.ts` |
| Host/Guest 会话创建 | `src/session/host.ts`, `src/session/guest.ts`, `src/session/index.ts` |
| 邀请链接格式 | `src/sync/share.ts` |
| 连接抽象 | `src/sync/connection.ts` |
| WebRTC/Trystero | `src/sync/trystero/index.ts`, `src/webview/main.tsx` |
| WebSocket 中继 | `src/sync/ws/server.ts`, `src/sync/ws/guest.ts`, `src/sync/ws/host.ts` |
| Yjs 同步 helper | `src/sync/doc.ts` |
| RPC | `src/rpc/types.ts`, `src/rpc/host.ts`, `src/rpc/guest.ts` |
| 虚拟文件系统 | `src/fs/provider.ts`, `src/fs/host.ts`, `src/fs/guest.ts` |
| 共享终端 | `src/terminal/common.ts`, `src/terminal/host.ts`, `src/terminal/guest.ts` |
| 端口转发 | `src/tunnel/index.ts`, `src/tunnel/server.ts`, `src/tunnel/client.ts`, `src/ui/tunnels.ts` |
| 远程语言服务 | `src/ls/common.ts`, `src/ls/host.ts`, `src/ls/guest.ts` |
| 诊断同步 | `src/diagnostics/host.ts`, `src/diagnostics/guest.ts` |
| 用户与参与者 | `src/ui/users.ts`, `src/ui/participants.ts` |
| 选区同步 | `src/ui/selections.ts` |
| Webview 通信 | `src/webview/index.ts`, `src/webview/main.tsx` |
| 聊天 | `src/webview/components/Chat.tsx` |
| SCM 草稿 | `src/scm/host.ts`, `src/scm/guest.ts`, `src/scm/types.ts` |
| 配置 | `package.json`, `src/configs.ts` |
| 构建目标 | `tsdown.config.ts` |
