/* global acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi()

  const SYSTEM = {
    role: 'system',
    content:
      'Você é a Mangaba AI, uma IA brasileira e soberana, rodando dentro do VS Code. ' +
      'Ajude com código e tarefas de engenharia: respostas diretas, em português, com blocos de código quando útil. ' +
      'Use markdown padrão (```linguagem para código).',
  }

  const $messages = document.getElementById('messages')
  const $input = document.getElementById('input')
  const $form = document.getElementById('composer')
  const $send = document.getElementById('send')

  /** @type {{role:string,content:string}[]} */
  let history = [SYSTEM]
  let streaming = false
  let curEl = null // assistant element being streamed

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  /** Markdown mínimo: blocos de código + inline code + quebras de linha. */
  function renderMarkdown(text) {
    const parts = text.split(/```/)
    let out = ''
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        const body = parts[i].replace(/^[a-zA-Z0-9_-]*\n/, '')
        out += `<pre><code>${escapeHtml(body)}</code></pre>`
      } else {
        out += escapeHtml(parts[i])
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\n/g, '<br/>')
      }
    }
    return out
  }

  function clearEmpty() {
    const e = $messages.querySelector('.empty')
    if (e) e.remove()
  }

  function addMessage(role, text) {
    clearEmpty()
    const el = document.createElement('div')
    el.className = 'msg ' + role
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.innerHTML = renderMarkdown(text)
    el.appendChild(bubble)
    $messages.appendChild(el)
    $messages.scrollTop = $messages.scrollHeight
    return bubble
  }

  function setStreaming(on) {
    streaming = on
    $send.textContent = on ? '■' : '➤'
    $send.title = on ? 'Parar' : 'Enviar'
    $input.disabled = false
  }

  function send(text) {
    const content = (text ?? $input.value).trim()
    if (!content || streaming) return
    history.push({ role: 'user', content })
    addMessage('user', content)
    $input.value = ''
    autoresize()
    history.push({ role: 'assistant', content: '' })
    curEl = addMessage('assistant', '')
    curEl.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>'
    setStreaming(true)
    vscode.postMessage({ type: 'send', history: history.slice(0, -1) })
  }

  function autoresize() {
    $input.style.height = 'auto'
    $input.style.height = Math.min($input.scrollHeight, 160) + 'px'
  }

  $form.addEventListener('submit', (e) => {
    e.preventDefault()
    if (streaming) { vscode.postMessage({ type: 'stop' }); return }
    send()
  })
  $input.addEventListener('input', autoresize)
  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  })

  window.addEventListener('message', (event) => {
    const m = event.data
    if (m.type === 'delta') {
      const last = history[history.length - 1]
      last.content += m.token
      if (curEl) curEl.innerHTML = renderMarkdown(last.content)
      $messages.scrollTop = $messages.scrollHeight
    } else if (m.type === 'done') {
      setStreaming(false)
      curEl = null
    } else if (m.type === 'error') {
      const last = history[history.length - 1]
      if (last && last.role === 'assistant' && !last.content) {
        last.content = '⚠️ ' + m.error
        if (curEl) curEl.innerHTML = renderMarkdown(last.content)
      } else {
        addMessage('assistant', '⚠️ ' + m.error)
      }
      setStreaming(false)
      curEl = null
    } else if (m.type === 'clear') {
      history = [SYSTEM]
      $messages.innerHTML =
        '<div class="empty"><div class="logo">🥭</div><p><strong>Mangaba AI</strong></p>' +
        '<p class="hint">Nova conversa.</p></div>'
      setStreaming(false)
      curEl = null
    } else if (m.type === 'prompt') {
      send(m.text)
    }
  })
})()
