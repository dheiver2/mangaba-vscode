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
  let pendingAtts = [] // anexos analisados aguardando envio (partes 'file')

  // Pede o contexto do editor (arquivo/seleção) ao host.
  vscode.postMessage({ type: 'getContext' })

  // Barra de ações da mensagem (delegação): Copiar / Regenerar / Editar.
  $messages.addEventListener('click', (e) => {
    const mt = e.target && e.target.closest ? e.target.closest('.mtool') : null
    if (mt) {
      const act = mt.dataset.act
      if (act === 'copy') {
        const b = mt.closest('.msg').querySelector('.bubble')
        if (b && navigator.clipboard) navigator.clipboard.writeText(b.innerText)
        flash(mt, 'Copiado', 'Copiar')
      } else if (act === 'regen' || act === 'retry') { regenerate() }
      else if (act === 'edit') { editLast() }
      return
    }
  })

  // Botões dos blocos de código (delegação): Aplicar / Inserir / Copiar.
  // Caminho de arquivo citado na resposta → abre no editor.
  $messages.addEventListener('click', (e) => {
    const fl = e.target && e.target.closest ? e.target.closest('.file-link') : null
    if (!fl) return
    vscode.postMessage({ type: 'openFile', name: fl.dataset.file, line: fl.dataset.line ? parseInt(fl.dataset.line, 10) : undefined })
  })
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
  const $newchat = document.getElementById('newchat')
  const $export = document.getElementById('export')
  const $slash = document.getElementById('slashmenu')
  const $tokens = document.getElementById('tokens')
  $history.addEventListener('click', () => vscode.postMessage({ type: 'openHistory' }))
  $ctxbtn.addEventListener('click', () => vscode.postMessage({ type: 'pickContext' }))
  $newchat.addEventListener('click', () => resetChat())
  $export.addEventListener('click', () => exportMarkdown())

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
    decorateLast()
  }

  // Pede ao host a lista de modelos do servidor Mangaba (/v1/models).
  vscode.postMessage({ type: 'getModels' })
  $model.addEventListener('change', () => {
    vscode.postMessage({ type: 'setModel', model: $model.value })
  })

  // ── Anexar arquivos (código, texto, PDF, imagem) — análise no host ───────
  // Botão → seletor nativo do VS Code (multi, qualquer tipo).
  $attach.addEventListener('click', () => vscode.postMessage({ type: 'attachFiles' }))
  // Input oculto como fallback (também aciona análise no host via base64).
  $file.addEventListener('change', () => {
    for (const f of $file.files || []) uploadFile(f)
    $file.value = ''
  })
  // Colar: imagens ou arquivos da área de transferência.
  $input.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || []
    let handled = false
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile()
        if (f) { uploadFile(f); handled = true }
      }
    }
    if (handled) e.preventDefault()
  })
  // Arrastar & soltar sobre o composer.
  ;['dragenter', 'dragover'].forEach((ev) => $form.addEventListener(ev, (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault(); $form.classList.add('dragover')
    }
  }))
  ;['dragleave', 'dragend'].forEach((ev) => $form.addEventListener(ev, (e) => {
    if (e.target === $form) $form.classList.remove('dragover')
  }))
  $form.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return
    e.preventDefault(); $form.classList.remove('dragover')
    for (const f of e.dataTransfer.files) uploadFile(f)
  })

  // Lê o arquivo como base64 e pede análise ao host.
  function uploadFile(file) {
    if (file.size > 12 * 1024 * 1024) { addMessage('assistant', '⚠️ "' + file.name + '" excede 12 MB.'); return }
    const r = new FileReader()
    r.onload = () => {
      const b64 = String(r.result).split(',')[1] || ''
      vscode.postMessage({ type: 'analyzeUpload', name: file.name || 'arquivo', data: b64 })
    }
    r.readAsDataURL(file)
  }

  // Ícone por tipo de anexo (SVG inline).
  function attIcon(a) {
    if (a.kind === 'image' && a.dataUrl) return '<img class="att-thumb" src="' + a.dataUrl + '" alt="" />'
    var d = a.kind === 'binary'
      ? 'M4 1.5A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V6L9 1.5H4Z'
      : 'M9 1.5H4A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V6L9 1.5Zm-.25 1.31L12.19 6H9.5a.75.75 0 0 1-.75-.75V2.81Z'
    return '<svg class="att-ico" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="' + d + '"/></svg>'
  }

  function renderAttachment() {
    $attachments.innerHTML = ''
    pendingAtts.forEach((a, idx) => {
      const chip = document.createElement('div')
      chip.className = 'att-chip' + (a.kind === 'image' ? ' img' : '') + (a.kind === 'binary' ? ' bin' : '')
      chip.innerHTML = attIcon(a) +
        '<span class="att-meta"><span class="att-name">' + escapeHtml(a.name) + '</span>' +
        (a.note ? '<span class="att-sub">' + escapeHtml(a.note) + '</span>' : '') + '</span>' +
        '<button class="att-x" title="Remover" aria-label="Remover">×</button>'
      chip.querySelector('.att-x').addEventListener('click', () => { pendingAtts.splice(idx, 1); renderAttachment(); updateTokens() })
      if (a.kind === 'text' && a.text) {
        const meta = chip.querySelector('.att-meta')
        meta.style.cursor = 'pointer'; meta.title = 'Pré-visualizar conteúdo'
        meta.addEventListener('click', () => vscode.postMessage({ type: 'openAttachment', name: a.name, lang: a.lang, data: a.text }))
      }
      $attachments.appendChild(chip)
    })
  }

  /** @type {{role:string,content:string}[]} */
  let history = [SYSTEM]
  let streaming = false
  let curEl = null // assistant element being streamed

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  // Caminho de arquivo citado em `code` vira link clicável que abre no editor.
  // Casa rel/caminho.ext e rel/caminho.ext:linha (extensões de código comuns).
  const FILE_RE = /^([\w@][\w@.\/-]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|go|rb|rs|c|cc|cpp|h|hpp|cs|php|kt|swift|scala|sh|sql|json|ya?ml|md|html|css|scss|less|vue|svelte|astro|toml|txt))(?::(\d+))?$/
  function codeOrFileLink(body) {
    const m = body.match(FILE_RE)
    if (m && body.indexOf('/') >= 0) {
      return '<code class="file-link" data-file="' + m[1] + '"' + (m[2] ? ' data-line="' + m[2] + '"' : '') +
        ' title="Abrir no editor">' + body + '</code>'
    }
    return '<code>' + body + '</code>'
  }

  // Formatação inline (tudo escapado antes) — negrito, itálico, code, links.
  function inline(s) {
    s = escapeHtml(s)
    s = s.replace(/`([^`]+)`/g, (_, body) => codeOrFileLink(body))
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    return s
  }

  // Linha de tabela markdown (| a | b |) e linha separadora (|---|:--:|).
  function isTableRow(line) { return /^\s*\|.*\|\s*$/.test(line) }
  function isTableSep(line) { return /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(line) }
  function splitCells(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  }

  // Blocos de texto: títulos, listas, citações, régua, tabelas, parágrafos.
  function renderText(seg) {
    const lines = seg.split('\n')
    let html = '', list = null, para = []
    const flushPara = () => { if (para.length) { html += '<p>' + para.map(inline).join('<br/>') + '</p>'; para = [] } }
    const closeList = () => { if (list) { html += '</' + list + '>'; list = null } }
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]
      let m
      if (isTableRow(line) && li + 1 < lines.length && isTableSep(lines[li + 1])) {
        flushPara(); closeList()
        const head = splitCells(line)
        let t = '<div class="tbl-wrap"><table><thead><tr>' + head.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'
        for (li += 2; li < lines.length && isTableRow(lines[li]) && !isTableSep(lines[li]); li++) {
          const cells = splitCells(lines[li])
          t += '<tr>' + head.map((_, ci) => '<td>' + inline(cells[ci] || '') + '</td>').join('') + '</tr>'
        }
        li--
        html += t + '</tbody></table></div>'
        continue
      }
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
      else if (part.type === 'file') {
        if (part.kind === 'image' && part.dataUrl) html += '<img class="att-img" src="' + part.dataUrl + '" alt="' + escapeHtml(part.name || '') + '" />'
        else html += '<span class="file-tag">' + attIcon(part) + '<span class="att-name">' + escapeHtml(part.name || 'arquivo') + '</span>' + (part.note ? '<span class="att-sub">' + escapeHtml(part.note) + '</span>' : '') + '</span>'
      }
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
    const tools = document.createElement('div')
    tools.className = 'msg-tools'
    tools.innerHTML = '<button class="mtool copy" data-act="copy" title="Copiar">Copiar</button>'
    el.appendChild(tools)
    $messages.appendChild(el)
    highlightIn(bubble)
    $messages.scrollTop = $messages.scrollHeight
    return bubble
  }

  // Decora as últimas mensagens: Regenerar (assistente) e Editar (usuário).
  function decorateLast() {
    $messages.querySelectorAll('.mtool.regen, .mtool.edit').forEach((b) => b.remove())
    if (streaming) return
    let lastA = null, lastU = null
    $messages.querySelectorAll('.msg').forEach((el) => {
      if (el.classList.contains('assistant')) lastA = el
      if (el.classList.contains('user')) lastU = el
    })
    if (lastA) addTool(lastA, 'regen', 'Regenerar')
    if (lastU) addTool(lastU, 'edit', 'Editar')
  }
  function addTool(msgEl, act, label) {
    const tools = msgEl.querySelector('.msg-tools')
    if (!tools) return
    const b = document.createElement('button')
    b.className = 'mtool ' + act; b.dataset.act = act; b.textContent = label
    tools.appendChild(b)
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
  updateTokens()

  function send(text) {
    const txt = (text ?? $input.value).trim()
    if ((!txt && !pendingAtts.length) || streaming) return
    let content
    if (pendingAtts.length) {
      content = []
      if (txt) content.push({ type: 'text', text: txt })
      for (const a of pendingAtts) content.push(a)
    } else {
      content = txt
    }
    history.push({ role: 'user', content })
    addMessage('user', content)
    pendingAtts = []
    renderAttachment()
    $input.value = ''
    autoresize()
    history.push({ role: 'assistant', content: '' })
    curEl = addMessage('assistant', '')
    curEl.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>'
    setStreaming(true)
    hideSlash(); updateTokens()
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
  $input.addEventListener('input', () => { autoresize(); slashIdx = 0; updateSlash(); updateTokens() })
  $input.addEventListener('keydown', (e) => {
    if (!$slash.hidden) {
      const items = JSON.parse($slash.dataset.items || '[]')
      if (e.key === 'ArrowDown') { e.preventDefault(); slashIdx = (slashIdx + 1) % items.length; updateSlash(); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashIdx = (slashIdx - 1 + items.length) % items.length; updateSlash(); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applySlash(items[slashIdx]); return }
      if (e.key === 'Escape') { e.preventDefault(); hideSlash(); return }
    }
    if (e.key === 'Escape' && streaming) { e.preventDefault(); vscode.postMessage({ type: 'stop' }); return }
    if (e.key === 'ArrowUp' && !$input.value && !streaming) { e.preventDefault(); editLast(); return }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  })

  // ── Comandos de barra (/) ────────────────────────────────────────────────
  const SLASH = [
    { c: '/explain', d: 'Explicar o arquivo/seleção atual', p: 'Explique o código do arquivo atual de forma objetiva, em português.' },
    { c: '/tests', d: 'Gerar testes', p: 'Gere testes para o código do arquivo atual.' },
    { c: '/doc', d: 'Documentar o código', p: 'Documente o código do arquivo atual com comentários claros, em português.' },
    { c: '/refactor', d: 'Refatorar mantendo o comportamento', p: 'Refatore o código do arquivo atual melhorando a legibilidade e mantendo o comportamento.' },
    { c: '/fix', d: 'Corrigir problemas do arquivo', p: 'Corrija os problemas/erros do arquivo atual e explique as mudanças.' },
    { c: '/export', d: 'Exportar conversa (Markdown)', a: 'export' },
    { c: '/clear', d: 'Nova conversa', a: 'clear' },
  ]
  let slashIdx = 0
  function updateSlash() {
    const v = $input.value
    if (v[0] !== '/' || /\s/.test(v)) { hideSlash(); return }
    const items = SLASH.filter((s) => s.c.startsWith(v.toLowerCase()))
    if (!items.length) { hideSlash(); return }
    if (slashIdx >= items.length) slashIdx = items.length - 1
    $slash.innerHTML = items.map((s, i) =>
      '<div class="slash-item' + (i === slashIdx ? ' sel' : '') + '" data-cmd="' + s.c + '"><b>' + s.c + '</b><span>' + escapeHtml(s.d) + '</span></div>').join('')
    $slash.dataset.items = JSON.stringify(items.map((s) => s.c))
    $slash.hidden = false
  }
  function hideSlash() { $slash.hidden = true; slashIdx = 0 }
  function applySlash(cmd) {
    const s = SLASH.find((x) => x.c === cmd); if (!s) return
    hideSlash()
    if (s.a === 'export') { $input.value = ''; updateTokens(); exportMarkdown(); return }
    if (s.a === 'clear') { $input.value = ''; resetChat(); return }
    $input.value = s.p; autoresize(); $input.focus(); updateTokens()
  }
  $slash.addEventListener('click', (e) => {
    const it = e.target.closest ? e.target.closest('.slash-item') : null
    if (it) applySlash(it.dataset.cmd)
  })

  // ── Nova conversa / exportar / regenerar / editar / tokens ───────────────
  function resetChat() {
    history = [SYSTEM]
    convId = newId()
    refChips = []
    pendingAtts = []
    renderCtxbar(); renderAttachment(); hideSlash()
    const logo = document.body.dataset.logo || ''
    $messages.innerHTML = '<div class="empty">' + (logo ? '<img class="logo-img" src="' + logo + '" alt="Mangaba AI" />' : '') + '<p class="hint">Nova conversa.</p></div>'
    $input.value = ''; setStreaming(false); curEl = null; autoresize(); updateTokens()
  }

  function msgText(content) {
    if (typeof content === 'string') return content
    return content.map((p) => p.type === 'text' ? p.text
      : p.type === 'file' ? '`[' + p.kind + '] ' + p.name + '`'
      : p.type === 'image_url' ? '`[imagem]`' : '').filter(Boolean).join('\n\n')
  }
  function exportMarkdown() {
    const lines = ['# Conversa Mangaba AI', '']
    for (const m of history) {
      if (m.role === 'system') continue
      lines.push(m.role === 'user' ? '### Você' : '### Mangaba', '', msgText(m.content), '')
    }
    if (lines.length <= 2) return
    vscode.postMessage({ type: 'exportMarkdown', data: lines.join('\n') })
  }

  function regenerate() {
    if (streaming) return
    while (history.length && history[history.length - 1].role === 'assistant') history.pop()
    const lastUser = history[history.length - 1]
    if (!lastUser || lastUser.role !== 'user') return
    renderHistory()
    history.push({ role: 'assistant', content: '' })
    curEl = addMessage('assistant', '')
    curEl.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>'
    setStreaming(true)
    vscode.postMessage({ type: 'send', history: history.slice(0, -1) })
    updateTokens()
  }
  function editLast() {
    if (streaming) return
    let i = history.length - 1
    while (i >= 0 && history[i].role !== 'user') i--
    if (i < 0) return
    const text = msgText(history[i].content)
    history = history.slice(0, i)
    renderHistory(); decorateLast()
    $input.value = text; autoresize(); $input.focus(); updateTokens()
  }

  function estTok(s) { return s ? Math.ceil(s.length / 4) : 0 }
  function updateTokens() {
    let t = estTok($input.value)
    for (const a of pendingAtts) t += estTok(a.text || '') + 4
    for (const m of history) { if (m.role !== 'system') t += estTok(msgText(m.content)) }
    if (!t) { $tokens.textContent = ''; $tokens.classList.remove('warn'); return }
    $tokens.textContent = '~' + (t >= 1000 ? (t / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(t)) + ' tokens'
    $tokens.classList.toggle('warn', t > 6000)
  }

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
      decorateLast(); updateTokens()
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
      decorateLast() // o botão "Regenerar" na última resposta serve de retry
    } else if (m.type === 'clear') {
      resetChat()
    } else if (m.type === 'requestExport') {
      exportMarkdown()
    } else if (m.type === 'models') {
      $model.innerHTML = ''
      for (const id of m.models) {
        const opt = document.createElement('option')
        opt.value = id
        opt.textContent = id
        if (id === m.current) opt.selected = true
        $model.appendChild(opt)
      }
    } else if (m.type === 'attachments') {
      if (m.items && m.items.length) { pendingAtts.push.apply(pendingAtts, m.items); renderAttachment(); updateTokens() }
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
      renderHistory(); decorateLast()
      renderCtxbar(); updateTokens()
    } else if (m.type === 'prompt') {
      send(m.text)
    }
  })
})()
