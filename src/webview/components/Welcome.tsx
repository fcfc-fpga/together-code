import { defineAsyncComponent, defineComponent } from 'vue'
import { rpc, state } from '../main'

export default defineAsyncComponent(async () => {
  const platform = await rpc.getPlatform()

  return defineComponent(() => () => {
    const isJoining = state.value === 'joining'
    const canHost = platform === 'desktop'

    return (
      <div class="tc-page tc-page-welcome">
        <section class="tc-surface tc-hero-card">
          <h1 class="tc-hero-title">协同编码</h1>
          <p class="tc-hero-description">
            与他人实时协同编码。
          </p>
          <div class="tc-welcome-actions">
            <button
              type="button"
              class="tc-btn tc-btn-primary tc-welcome-action"
              disabled={!canHost || isJoining}
              onClick={() => {
                if (!canHost)
                  return
                rpc.share()
                state.value = 'joining'
              }}
            >
              {canHost ? '发起会话' : '桌面端发起'}
            </button>
            <button
              type="button"
              class="tc-btn tc-btn-secondary tc-welcome-action"
              disabled={isJoining}
              onClick={() => {
                rpc.join('auto')
                state.value = 'joining'
              }}
            >
              加入会话
            </button>
          </div>
          <div class="tc-hero-note">
            {isJoining
              ? '正在连接会话...'
              : canHost
                ? '支持会话发起、成员协作和实时聊天。'
                : '如需发起会话，请在 VS Code 桌面版中运行扩展。'}
          </div>
        </section>
      </div>
    )
  }, { name: 'Welcome' })
})
