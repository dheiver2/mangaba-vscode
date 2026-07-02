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
  const $model = document.getElementById('model')
  const $attach = document.getElementById('attach')
  const $file = document.getElementById('file')
  const $attachments = document.getElementById('attachments')

  let pendingImage = null // dataURL da imagem anexada

  // Pede ao host a lista de modelos do servidor Mangaba (/v1/models).
  vscode.postMessage({ type: 'getModels' })
  $model.addEventListener('change', () => {
    vscode.postMessage({ type: 'setModel', model: $model.value })
  })

  // ── Anexar imagem (para o modelo de visão) ──────────────────────────────
  $attach.addEventListener('click', () => $file.click())
  $file.addEventListener('change', () => {
    const f = $file.files && $file.files[0]
    if (f) readImage(f)
    $file.value = ''
  })
  $input.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || []
    for (const it of items) {
      if (it.type && it.type.indexOf('image') === 0) {
        const f = it.getAsFile()
        if (f) { readImage(f); e.preventDefault() }
        break
      }
    }
  })
  function readImage(file) {
    const r = new FileReader()
    r.onload = () => { pendingImage = r.result; renderAttachment() }
    r.readAsDataURL(file)
  }
  function renderAttachment() {
    $attachments.innerHTML = ''
    if (!pendingImage) return
    const chip = document.createElement('div')
    chip.className = 'att-chip'
    chip.innerHTML = '<img src="' + pendingImage + '" /><button title="Remover" aria-label="Remover">×</button>'
    chip.querySelector('button').addEventListener('click', () => { pendingImage = null; renderAttachment() })
    $attachments.appendChild(chip)
  }

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

  function contentToHtml(content) {
    if (typeof content === 'string') return renderMarkdown(content)
    let html = ''
    for (const part of content) {
      if (part.type === 'text' && part.text) html += renderMarkdown(part.text)
      else if (part.type === 'image_url' && part.image_url) html += '<img class="att-img" src="' + part.image_url.url + '" alt="imagem" />'
    }
    return html
  }

  function addMessage(role, content) {
    clearEmpty()
    const el = document.createElement('div')
    el.className = 'msg ' + role
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.innerHTML = contentToHtml(content)
    el.appendChild(bubble)
    $messages.appendChild(el)
    $messages.scrollTop = $messages.scrollHeight
    return bubble
  }

  var SEND_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.5a.75.75 0 0 1 .53.22l4.5 4.5a.75.75 0 1 1-1.06 1.06L8.75 4.56V14a.75.75 0 0 1-1.5 0V4.56L4.03 7.28a.75.75 0 0 1-1.06-1.06l4.5-4.5A.75.75 0 0 1 8 1.5Z"/></svg>'
  var STOP_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>'

  function setStreaming(on) {
    streaming = on
    $send.innerHTML = on ? STOP_SVG : SEND_SVG
    $send.title = on ? 'Parar' : 'Enviar'
    $input.disabled = false
  }
  setStreaming(false)

  function send(text) {
    const txt = (text ?? $input.value).trim()
    if ((!txt && !pendingImage) || streaming) return
    let content
    if (pendingImage) {
      content = []
      if (txt) content.push({ type: 'text', text: txt })
      content.push({ type: 'image_url', image_url: { url: pendingImage } })
    } else {
      content = txt
    }
    history.push({ role: 'user', content })
    addMessage('user', content)
    pendingImage = null
    renderAttachment()
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
      const logo = document.body.dataset.logo || ''
      $messages.innerHTML =
        '<div class="empty">' +
        (logo ? '<img class="logo-img" src="' + logo + '" alt="Mangaba AI" />' : '') +
        '<p class="hint">Nova conversa.</p></div>'
      setStreaming(false)
      curEl = null
    } else if (m.type === 'models') {
      $model.innerHTML = ''
      for (const id of m.models) {
        const opt = document.createElement('option')
        opt.value = id
        opt.textContent = id
        if (id === m.current) opt.selected = true
        $model.appendChild(opt)
      }
    } else if (m.type === 'prompt') {
      send(m.text)
    }
  })
})()
