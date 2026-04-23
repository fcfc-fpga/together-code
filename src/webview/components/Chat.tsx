import { defineComponent, nextTick, onMounted, onUnmounted, ref, watchEffect } from 'vue'
import { rpc, state } from '../main'

export interface ChatAttachment {
  name: string
  type: string
  size: number
  base64: string
}

export interface ChatMessage {
  id?: string
  sender: string
  senderIdentity?: string
  senderName: string
  content?: string
  image?: string
  file?: ChatAttachment
  attachments?: ChatAttachment[]
  timestamp: number
}

interface DraftAttachment extends ChatAttachment {
  draftId: string
}

const chatMessages = ref<ChatMessage[]>([])
const ChatImageThumbnailWidth = 168
const ChatImageThumbnailAspectRatio = '4 / 3'

export function recvChatMessage(message: ChatMessage | 'clear') {
  if (message === 'clear') {
    chatMessages.value = []
  }
  else {
    appendChatMessage(message)
  }
}

export default defineComponent(() => {
  const ParticipantTooltipAnchorOffsetX = 16
  const ParticipantTooltipAnchorOffsetY = 10
  const ParticipantTooltipViewportPadding = 12
  const editingMessage = ref('')
  const textareaRef = ref<HTMLTextAreaElement | null>(null)
  const messagesContainerRef = ref<HTMLElement | null>(null)
  const isDragging = ref(false)
  const draftAttachments = ref<DraftAttachment[]>([])
  const previewImage = ref<null | { src: string, title: string }>(null)
  const participantTooltipRef = ref<HTMLElement | null>(null)
  const participantTooltip = ref<null | { text: string, x: number, y: number }>(null)

  const userName = rpc.getSelfName()
  const userIdentity = rpc.getSelfIdentity()
  const currentUserName = ref<string | null>(null)
  const currentUserIdentity = ref<string | null>(null)

  onMounted(() => {
    requestAnimationFrame(autoResize)
    window.addEventListener('keydown', handleWindowKeydown)
    void Promise.all([userName, userIdentity]).then(([resolvedName, resolvedIdentity]) => {
      currentUserName.value = resolvedName
      currentUserIdentity.value = resolvedIdentity
    })
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', handleWindowKeydown)
  })

  watchEffect(() => {
    if (!state.value) {
      chatMessages.value = []
      draftAttachments.value = []
      previewImage.value = null
    }
  })

  watchEffect(() => {
    const _len = chatMessages.value.length
    if (_len === 0)
      return
    nextTick(() => {
      const el = messagesContainerRef.value
      if (!el)
        return
      el.scrollTop = el.scrollHeight
    })
  })

  function getCurrentSelfId() {
    return typeof state.value === 'object' ? state.value.selfId : null
  }

  function getSessionState() {
    return typeof state.value === 'object' ? state.value : null
  }

  function isSelfMessage(message: ChatMessage) {
    if (message.sender === getCurrentSelfId()) {
      return true
    }
    if (message.senderIdentity && currentUserIdentity.value) {
      return message.senderIdentity === currentUserIdentity.value
    }
    if (message.senderName && currentUserName.value) {
      return message.senderName === currentUserName.value
    }
    return false
  }

  function getMessagePartyKey(message: ChatMessage) {
    return message.senderIdentity || message.sender || message.senderName
  }

  function shouldShowMessageHeader(message: ChatMessage, index: number) {
    if (index === 0) {
      return true
    }
    const previous = chatMessages.value[index - 1]
    return getMessagePartyKey(previous) !== getMessagePartyKey(message)
  }

  async function sendMessage() {
    const sender = getCurrentSelfId()
    if (!sender) {
      return
    }

    const content = editingMessage.value
    const attachments = draftAttachments.value.map(({ draftId: _draftId, ...attachment }) => attachment)
    if (content.trim() === '' && attachments.length === 0) {
      return
    }

    const message: ChatMessage = {
      id: createMessageId(),
      sender,
      senderIdentity: await userIdentity || undefined,
      senderName: await userName || sender,
      content: content.trim() === '' ? undefined : content,
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp: Date.now(),
    }

    appendChatMessage(message)
    rpc.sendChatMessage(message)
    editingMessage.value = ''
    draftAttachments.value = []
    nextTickResize()
  }

  async function addDraftFiles(files: ArrayLike<File>) {
    const normalizedFiles = Array.from(files).filter(file => file.size > 0)
    if (normalizedFiles.length === 0) {
      return
    }

    const nextAttachments = await Promise.all(normalizedFiles.map(async (file) => {
      const base64 = await readFileAsDataUrl(file)
      return {
        draftId: createDraftAttachmentId(),
        name: file.name || inferAttachmentName(file.type),
        type: file.type || 'application/octet-stream',
        size: file.size,
        base64,
      } satisfies DraftAttachment
    }))

    draftAttachments.value = [...draftAttachments.value, ...nextAttachments]
  }

  function removeDraftAttachment(draftId: string) {
    draftAttachments.value = draftAttachments.value.filter(attachment => attachment.draftId !== draftId)
  }

  function openImagePreview(src: string, title: string) {
    previewImage.value = { src, title }
  }

  function closeImagePreview() {
    previewImage.value = null
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && previewImage.value) {
      closeImagePreview()
    }
  }

  function isImageOrVideo(type: string): boolean {
    return type.startsWith('image/') || type.startsWith('video/')
  }

  function isImage(type: string) {
    return type.startsWith('image/')
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024)
      return `${bytes} B`
    if (bytes < 1024 * 1024)
      return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  function downloadFile(file: ChatAttachment) {
    const link = document.createElement('a')
    link.href = file.base64
    link.download = file.name
    link.click()
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault()
    isDragging.value = true
  }

  function handleDragLeave(event: DragEvent) {
    event.preventDefault()
    isDragging.value = false
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault()
    isDragging.value = false

    const files = event.dataTransfer?.files
    if (!files || files.length === 0) {
      return
    }
    void addDraftFiles(files)
  }

  function handlePaste(event: ClipboardEvent) {
    const items = event.clipboardData?.items
    if (!items) {
      return
    }

    const files: File[] = []
    for (let i = 0; i < items.length; i++) {
      const file = items[i].getAsFile()
      if (file) {
        files.push(file)
      }
    }

    if (files.length > 0) {
      event.preventDefault()
      void addDraftFiles(files)
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  function nextTickResize() {
    requestAnimationFrame(autoResize)
  }

  function autoResize() {
    const textarea = textareaRef.value
    if (!textarea)
      return
    textarea.style.height = 'auto'
    const max = Math.max(window.innerHeight / 3, 84)
    textarea.style.height = `${Math.min(textarea.scrollHeight, max)}px`
  }

  function formatTime(timestamp: number) {
    return new Date(timestamp).toLocaleTimeString()
  }

  function formatPing(ping: number | null) {
    if (ping === null) {
      return null
    }
    if (!Number.isFinite(ping)) {
      return '延迟 --'
    }
    return `${Math.round(ping)} ms`
  }

  function getParticipantMeta(participant: NonNullable<ReturnType<typeof getSessionState>>['participants'][number]) {
    if (participant.isSelf) {
      return participant.isHost ? '主机 · 我' : '我'
    }

    const ping = formatPing(participant.ping)
    if (participant.isHost) {
      return ping ? `主机 · ${ping}` : '主机'
    }

    return ping
  }

  function renderParticipantMarker(participant: NonNullable<ReturnType<typeof getSessionState>>['participants'][number]) {
    return (
      <div
        class="tc-participant-marker"
        style={{
          background: participant.color.bg,
          boxShadow: `0 0 0 3px ${withOpacity(participant.color.bg, 0.16)}`,
        }}
      />
    )
  }

  function getParticipantJumpTitle(participant: NonNullable<ReturnType<typeof getSessionState>>['participants'][number]) {
    if (participant.isSelf) {
      return undefined
    }
    return participant.positionLabel
      ? `点击跳转至：${participant.positionLabel}`
      : '点击跳转至：该参与者当前光标位置'
  }

  function showParticipantTooltip(
    participant: NonNullable<ReturnType<typeof getSessionState>>['participants'][number],
    target: HTMLElement,
  ) {
    const text = getParticipantJumpTitle(participant)
    if (!text) {
      participantTooltip.value = null
      return
    }
    participantTooltip.value = {
      text,
      x: 0,
      y: 0,
    }
    void nextTick(() => {
      const tooltip = participantTooltipRef.value
      if (!tooltip || participantTooltip.value?.text !== text) {
        return
      }
      const rect = target.getBoundingClientRect()
      const tooltipWidth = tooltip.offsetWidth
      const tooltipHeight = tooltip.offsetHeight
      const desiredX = rect.left + ParticipantTooltipAnchorOffsetX
      const desiredY = rect.bottom + ParticipantTooltipAnchorOffsetY
      const maxX = window.innerWidth - tooltipWidth - ParticipantTooltipViewportPadding
      const maxY = window.innerHeight - tooltipHeight - ParticipantTooltipViewportPadding
      participantTooltip.value = {
        text,
        x: Math.max(ParticipantTooltipViewportPadding, Math.min(desiredX, maxX)),
        y: Math.max(ParticipantTooltipViewportPadding, Math.min(desiredY, maxY)),
      }
    })
  }

  function hideParticipantTooltip() {
    participantTooltip.value = null
  }

  function renderFileCard(file: ChatAttachment, compact = false) {
    return (
      <div class={`tc-file-card${compact ? ' tc-file-card-compact' : ''}`}>
        <div class="tc-file-card-icon">📄</div>
        <div class="tc-file-card-body">
          <div class="tc-file-card-name">{file.name}</div>
          <div class="tc-file-card-meta">{formatFileSize(file.size)}</div>
        </div>
        <button
          type="button"
          class="tc-icon-button"
          onClick={() => downloadFile(file)}
        >
          ⬇
        </button>
      </div>
    )
  }

  function renderMessageAttachment(attachment: ChatAttachment, index: number) {
    if (isImage(attachment.type)) {
      return (
        <div
          key={`${attachment.name}-${attachment.size}-${index}`}
          class="tc-message-media"
          style={{
            width: `${ChatImageThumbnailWidth}px`,
            maxWidth: '100%',
            aspectRatio: ChatImageThumbnailAspectRatio,
          }}
        >
          <img
            src={attachment.base64}
            alt={attachment.name}
            onClick={() => openImagePreview(attachment.base64, attachment.name)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
              cursor: 'zoom-in',
            }}
          />
        </div>
      )
    }

    if (attachment.type.startsWith('video/')) {
      return (
        <video
          key={`${attachment.name}-${attachment.size}-${index}`}
          src={attachment.base64}
          controls
          class="tc-message-video"
        />
      )
    }

    return (
      <div key={`${attachment.name}-${attachment.size}-${index}`}>
        {renderFileCard(attachment)}
      </div>
    )
  }

  function renderDraftAttachment(attachment: DraftAttachment) {
    if (isImage(attachment.type)) {
      return (
        <div
          key={attachment.draftId}
          class="tc-draft-media"
        >
          <img
            src={attachment.base64}
            alt={attachment.name}
            onClick={() => openImagePreview(attachment.base64, attachment.name)}
            class="tc-draft-media-image"
          />
          <button
            type="button"
            class="tc-draft-remove"
            onClick={() => removeDraftAttachment(attachment.draftId)}
          >
            ×
          </button>
        </div>
      )
    }

    return (
      <div key={attachment.draftId}>
        {renderFileCard(attachment, true)}
      </div>
    )
  }

  return () => {
    const sessionState = getSessionState()
    const onlineCount = sessionState?.participants.length ?? 0

    return (
      <div class="tc-page">
        <section class="tc-surface tc-status-bar">
          <div class="tc-status-copy">
            <div class="tc-status-title">会话进行中</div>
          </div>
          <div class="tc-status-actions">
            {sessionState?.role === 'host' && (
              <button
                type="button"
                class="tc-btn tc-status-button tc-status-button-copy"
                onClick={() => rpc.copyInviteLink()}
              >
                复制链接
              </button>
            )}
            <button
              type="button"
              class="tc-btn tc-status-button tc-status-button-danger"
              onClick={() => rpc.leave()}
            >
              {sessionState?.role === 'host' ? '结束会话' : '离开会话'}
            </button>
          </div>
        </section>

        <section class="tc-surface tc-participants-panel">
          <div class="tc-section-head">
            <div class="tc-section-title">参与者</div>
            <div class="tc-online-count" aria-label={`${onlineCount} 人在线`}>
              <span class="tc-online-count-dot" aria-hidden="true"></span>
              <span class="tc-online-count-text">{onlineCount} 人在线</span>
            </div>
          </div>
          <div class="tc-participant-list">
            {sessionState?.participants.map((participant) => {
              const participantMeta = getParticipantMeta(participant)
              return (
                <button
                  key={participant.id}
                  type="button"
                  class="tc-participant-row"
                  disabled={participant.isSelf}
                  onMouseenter={(event: MouseEvent) => {
                    const target = event.currentTarget as HTMLElement | null
                    if (!target) {
                      return
                    }
                    showParticipantTooltip(participant, target)
                  }}
                  onMouseleave={hideParticipantTooltip}
                  onFocus={(event: FocusEvent) => {
                    const target = event.currentTarget as HTMLElement | null
                    if (!target) {
                      return
                    }
                    showParticipantTooltip(participant, target)
                  }}
                  onBlur={hideParticipantTooltip}
                  onClick={() => {
                    if (!participant.isSelf) {
                      rpc.jumpToParticipant(participant.id)
                    }
                  }}
                >
                  {renderParticipantMarker(participant)}
                  <div class="tc-participant-copy">
                    <div class="tc-participant-line">
                      <span class="tc-participant-name">{participant.name}</span>
                    </div>
                  </div>
                  {participantMeta && (
                    <span class="tc-participant-meta tc-participant-meta-trailing">{participantMeta}</span>
                  )}
                </button>
              )
            })}
          </div>
        </section>

        <section class="tc-surface tc-chat-layout tc-chat-panel">
          <div class="tc-chat-head">
            <div class="tc-section-title">聊天</div>
          </div>

          <div ref={messagesContainerRef} class="tc-chat-feed">
            {chatMessages.value.length === 0
              ? (
                  <div class="tc-empty-state">
                    还没有消息，开始聊天吧。
                  </div>
                )
              : (
                  chatMessages.value.map((message, index) => {
                    const isSelf = isSelfMessage(message)
                    const attachments = normalizeMessageAttachments(message)
                    const showHeader = shouldShowMessageHeader(message, index)

                    return (
                      <div
                        key={message.id ?? `${message.sender}-${message.timestamp}-${index}`}
                        class={`tc-message-row ${isSelf ? 'tc-message-row-self' : 'tc-message-row-other'}${showHeader ? '' : ' tc-message-row-grouped'}`}
                      >
                        {showHeader && (
                          <div class="tc-message-meta">
                            <span>{isSelf ? '我' : message.senderName}</span>
                            <span>{formatTime(message.timestamp)}</span>
                          </div>
                        )}
                        <div class={`tc-message-bubble ${isSelf ? 'tc-message-bubble-self' : 'tc-message-bubble-other'}`}>
                          {message.content && (
                            <div class="tc-message-text">
                              {message.content}
                            </div>
                          )}
                          {attachments.length > 0 && (
                            <div class={`tc-message-attachments${message.content ? ' tc-message-attachments-after-text' : ''}`}>
                              {attachments.map((attachment, attachmentIndex) => renderMessageAttachment(attachment, attachmentIndex))}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })
                )}
          </div>

          <div
            class="tc-surface tc-composer"
            onDragover={handleDragOver}
            onDragleave={handleDragLeave}
            onDrop={handleDrop}
          >
            {isDragging.value && (
              <div class="tc-drag-overlay">
                松开即可添加到草稿
              </div>
            )}
            {draftAttachments.value.length > 0 && (
              <div class="tc-draft-strip">
                {draftAttachments.value.map(attachment => renderDraftAttachment(attachment))}
              </div>
            )}
            <div class="tc-composer-row">
              <textarea
                ref={textareaRef}
                class="tc-textarea"
                placeholder="按 Enter 发送，Shift+Enter 换行"
                value={editingMessage.value}
                onInput={(event: Event) => {
                  editingMessage.value = (event.target as HTMLTextAreaElement).value
                  autoResize()
                }}
                onKeydown={handleKeyDown}
                onPaste={handlePaste}
                rows={1}
              />
              <button
                type="button"
                class="tc-btn tc-btn-primary tc-send-button"
                disabled={editingMessage.value.trim() === '' && draftAttachments.value.length === 0}
                onClick={() => {
                  void sendMessage()
                }}
              >
                发送
              </button>
            </div>
          </div>
        </section>

        {previewImage.value && (
          <div class="tc-preview-overlay" onClick={closeImagePreview}>
            <div class="tc-preview-shell" onClick={event => event.stopPropagation()}>
              <div class="tc-preview-head">
                <div class="tc-preview-title">{previewImage.value.title}</div>
                <button
                  type="button"
                  class="tc-preview-close"
                  onClick={closeImagePreview}
                >
                  ×
                </button>
              </div>
              <img
                src={previewImage.value.src}
                alt={previewImage.value.title}
                class="tc-preview-image"
              />
            </div>
          </div>
        )}

        {participantTooltip.value && (
          <div
            ref={participantTooltipRef}
            class="tc-hover-tooltip"
            style={{
              left: `${participantTooltip.value.x}px`,
              top: `${participantTooltip.value.y}px`,
            }}
          >
            {participantTooltip.value.text}
          </div>
        )}
      </div>
    )
  }
}, { name: 'Chat' })

function appendChatMessage(message: ChatMessage) {
  const key = getMessageKey(message)
  if (chatMessages.value.some(existing => getMessageKey(existing) === key)) {
    return
  }
  chatMessages.value.push(message)
}

function normalizeMessageAttachments(message: ChatMessage): ChatAttachment[] {
  if (message.attachments?.length) {
    return message.attachments
  }
  if (message.file) {
    return [message.file]
  }
  if (message.image) {
    return [{
      name: '共享图片',
      type: 'image/*',
      size: 0,
      base64: message.image,
    }]
  }
  return []
}

function getAttachmentKey(attachment: ChatAttachment) {
  return `${attachment.name}:${attachment.size}:${attachment.type}:${attachment.base64.slice(0, 64)}`
}

function getMessageKey(message: ChatMessage) {
  if (message.id) {
    return message.id
  }
  const attachments = normalizeMessageAttachments(message)
  if (attachments.length > 0) {
    return `${message.sender}:${message.timestamp}:attachments:${attachments.map(getAttachmentKey).join('|')}:text:${message.content ?? ''}`
  }
  return `${message.sender}:${message.timestamp}:text:${message.content ?? ''}`
}

function createMessageId() {
  const sender = typeof state.value === 'object' ? state.value.selfId : 'chat'
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${sender}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function createDraftAttachmentId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (event) => {
      const result = event.target?.result
      if (typeof result === 'string') {
        resolve(result)
      }
      else {
        reject(new Error('Failed to read file'))
      }
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

function inferAttachmentName(type: string) {
  if (type.startsWith('image/')) {
    return '图片'
  }
  if (type.startsWith('video/')) {
    return '视频'
  }
  return '附件'
}

function withOpacity(color: string, opacity: number) {
  const match = color.match(/rgba?\((\d+), (\d+), (\d+)(, ([\d.]+))?\)/)
  if (!match) {
    return `rgba(96, 170, 255, ${opacity})`
  }
  const [, r, g, b] = match
  return `rgba(${r}, ${g}, ${b}, ${opacity})`
}
