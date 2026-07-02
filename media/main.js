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

  const $ctxbar = document.getElementById('ctxbar')
  let pendingImage = null // dataURL da imagem anexada

  // Pede o contexto do editor (arquivo/seleção) ao host.
  vscode.postMessage({ type: 'getContext' })

  // Botões dos blocos de código (delegação): Aplicar / Inserir / Copiar.
  $messages.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.code-act') : null
    if (!btn) return
    const wrap = btn.closest('.code-wrap')
    if (!wrap) return
    const code = decodeURIComponent(wrap.getAttribute('data-code') || '')
    const act = btn.getAttribute('data-act')
    if (act === 'copy') {
      if (navigator.clipboard) navigator.clipboard.writeText(code)
      flash(btn, 'Copiado', 'Copiar')
    } else {
      vscode.postMessage({ type: 'apply', code: code, mode: act === 'insert' ? 'insert' : 'replaceSelection' })
      flash(btn, act === 'insert' ? 'Inserido' : 'Aplicado', act === 'insert' ? 'Inserir' : 'Aplicar')
    }
  })
  function flash(btn, on, off) { btn.textContent = on; setTimeout(() => { btn.textContent = off }, 1400) }

  // Histórico + @-contexto
  const $history = document.getElementById('history')
  const $ctxbtn = document.getElementById('ctxbtn')
  $history.addEventListener('click', () => vscode.postMessage({ type: 'openHistory' }))
  $ctxbtn.addEventListener('click', () => vscode.postMessage({ type: 'pickContext' }))

  function newId() { return 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) }
  let convId = newId()
  let lastCtxChip = null   // chip do arquivo/seleção automáticos
  let refChips = []        // chips das @-refs escolhidas

  function firstUserTitle() {
    const u = history.find((m) => m.role === 'user')
    if (!u) return 'Conversa'
    const t = typeof u.content === 'string' ? u.content : (u.content.find((p) => p.type === 'text') || {}).text || 'Conversa'
    return t.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Conversa'
  }
  function persist() {
    vscode.postMessage({ type: 'save', id: convId, title: firstUserTitle(), history: history })
  }
  function renderCtxbar() {
    let html = ''
    if (lastCtxChip) html += '<span class="ctx-chip" title="Enviado como contexto">◧ ' + escapeHtml(lastCtxChip.file) + (lastCtxChip.hasSel ? ' · seleção' : '') + '</span>'
    for (const c of refChips) html += '<span class="ctx-chip ref" title="Contexto extra (@)">' + escapeHtml(c) + '</span>'
    $ctxbar.innerHTML = html
  }
  function renderHistory() {
    $messages.innerHTML = ''
    for (const m of history) {
      if (m.role === 'system') continue
      addMessage(m.role, m.content)
    }
    if (history.filter((m) => m.role !== 'system').length === 0) {
      $messages.innerHTML = '<div class="empty"><img class="logo-img" src="' + (document.body.dataset.logo || '') + '" alt="Mangaba AI" /><p class="hint">Nova conversa.</p></div>'
    }
  }

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
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  // Formatação inline (tudo escapado antes) — negrito, itálico, code, links.
  function inline(s) {
    s = escapeHtml(s)
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    return s
  }

  // Blocos de texto: títulos, listas, citações, régua, parágrafos.
  function renderText(seg) {
    const lines = seg.split('\n')
    let html = '', list = null, para = []
    const flushPara = () => { if (para.length) { html += '<p>' + para.map(inline).join('<br/>') + '</p>'; para = [] } }
    const closeList = () => { if (list) { html += '</' + list + '>'; list = null } }
    for (const line of lines) {
      let m
      if (/^\s*$/.test(line)) { flushPara(); closeList(); continue }
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); closeList(); const l = m[1].length; html += '<h' + l + '>' + inline(m[2]) + '</h' + l + '>'; continue }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); closeList(); html += '<hr/>'; continue }
      if ((m = line.match(/^\s*>\s?(.*)$/))) { flushPara(); closeList(); html += '<blockquote>' + inline(m[1]) + '</blockquote>'; continue }
      if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { flushPara(); if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul' } html += '<li>' + inline(m[1]) + '</li>'; continue }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol' } html += '<li>' + inline(m[1]) + '</li>'; continue }
      if (list) closeList()
      para.push(line)
    }
    flushPara(); closeList()
    return html
  }

  /** Markdown: blocos de código (com rótulo + ações) + texto rico. */
  function renderMarkdown(text) {
    const parts = text.split(/```/)
    let out = ''
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        const mm = parts[i].match(/^([a-zA-Z0-9_+#.-]*)\n?([\s\S]*)$/)
        const lang = (mm && mm[1]) || ''
        const body = (mm ? mm[2] : parts[i])
        const cls = lang ? ' class="language-' + lang.toLowerCase() + '"' : ''
        out += '<div class="code-wrap" data-code="' + encodeURIComponent(body) + '">' +
          '<div class="code-bar">' +
          '<span class="code-lang">' + escapeHtml(lang || 'código') + '</span>' +
          '<span class="code-acts">' +
          '<button class="code-act" data-act="apply" title="Substituir a seleção (ou inserir no cursor)">Aplicar</button>' +
          '<button class="code-act" data-act="insert" title="Inserir no cursor">Inserir</button>' +
          '<button class="code-act" data-act="copy" title="Copiar">Copiar</button>' +
          '</span></div><pre><code' + cls + '>' + escapeHtml(body) + '</code></pre></div>'
      } else {
        out += renderText(parts[i])
      }
    }
    return out
  }

  // Aplica syntax highlighting nos blocos de código de um elemento (uma vez).
  function highlightIn(el) {
    if (!el || typeof hljs === 'undefined') return
    const blocks = el.querySelectorAll('pre code')
    for (const c of blocks) {
      if (c.getAttribute('data-hl')) continue
      try { hljs.highlightElement(c) } catch (_) { /* ignora */ }
      c.setAttribute('data-hl', '1')
    }
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
    highlightIn(bubble)
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
      if (curEl) highlightIn(curEl)
      setStreaming(false)
      curEl = null
      persist()
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
      convId = newId()
      refChips = []
      renderCtxbar()
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
    } else if (m.type === 'context') {
      lastCtxChip = m.ctx || null
      renderCtxbar()
    } else if (m.type === 'refs') {
      refChips = m.chips || []
      renderCtxbar()
    } else if (m.type === 'loaded') {
      convId = m.id || newId()
      history = (m.messages && m.messages.length) ? m.messages : [SYSTEM]
      refChips = []
      renderHistory()
      renderCtxbar()
    } else if (m.type === 'prompt') {
      send(m.text)
    }
  })
})()
