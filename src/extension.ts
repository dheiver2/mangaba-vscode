import * as vscode from 'vscode'

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
interface Msg { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }

function cfg() {
  const c = vscode.workspace.getConfiguration('mangaba')
  return {
    baseUrl:          (c.get<string>('baseUrl') || '').replace(/\/+$/, ''),
    model:            c.get<string>('model') || 'mangaba-pro',
    apiKey:           c.get<string>('apiKey') || '',
    temperature:      c.get<number>('temperature') ?? 0.7,
    maxTokens:        c.get<number>('maxTokens') ?? 4096,
    includeActiveFile: c.get<boolean>('includeActiveFile') ?? true,
    maxContextChars:  c.get<number>('maxContextChars') ?? 6000,
    reviewBeforeApply: c.get<boolean>('reviewBeforeApply') ?? true,
    inlineCompletions: c.get<boolean>('inlineCompletions') ?? false,
  }
}

// Documento virtual usado no diff de revisão ("proposto").
const DIFF_SCHEME = 'mangaba-diff'
const diffContents = new Map<string, string>()

function currentModel(ctx: vscode.ExtensionContext): string {
  return ctx.globalState.get<string>('mangaba.model') || cfg().model
}

function stripFences(s: string): string {
  return s.replace(/^\s*```[a-zA-Z0-9_+#.-]*\n?/, '').replace(/\n?```\s*$/, '').replace(/\s+$/, '')
}

/** Chamada não-streaming ao modelo. Retorna o conteúdo (ou null). */
async function chatOnce(
  ctx: vscode.ExtensionContext,
  messages: Msg[],
  temperature = 0.2,
): Promise<string | null> {
  const c = cfg()
  if (!c.baseUrl) return null
  try {
    const res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST', headers: authHeaders(c),
      body: JSON.stringify({ model: currentModel(ctx), messages, temperature, max_tokens: c.maxTokens, stream: false }),
    })
    if (!res.ok) return null
    const d = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return d.choices?.[0]?.message?.content ?? null
  } catch {
    return null
  }
}

interface SavedConv { id: string; title: string; messages: Msg[]; ts: number }

function authHeaders(c: ReturnType<typeof cfg>) {
  return {
    'Content-Type': 'application/json',
    'ngrok-skip-browser-warning': '1',
    ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
  }
}

class MangabaViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'mangaba.chatView'
  private view?: vscode.WebviewView
  private abort?: AbortController
  private lastEditor?: vscode.TextEditor
  private pendingRefs: string[] = []      // notas de contexto (@) para o próximo envio
  private pendingChips: string[] = []

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.lastEditor = vscode.window.activeTextEditor
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view
    view.webview.options = { enableScripts: true, localResourceRoots: [this.ctx.extensionUri] }
    view.webview.html = this.html(view.webview)
    view.webview.onDidReceiveMessage(async (m: { type: string; history?: Msg[]; model?: string; code?: string; mode?: string; id?: string; title?: string }) => {
      if (m.type === 'send' && m.history) await this.stream(m.history)
      else if (m.type === 'stop') this.abort?.abort()
      else if (m.type === 'getModels') await this.sendModels()
      else if (m.type === 'setModel' && m.model) await this.ctx.globalState.update('mangaba.model', m.model)
      else if (m.type === 'apply' && typeof m.code === 'string') await this.applyCode(m.code, m.mode)
      else if (m.type === 'getContext') this.updateContext()
      else if (m.type === 'pickContext') await this.pickContext()
      else if (m.type === 'save' && m.id && m.history) this.saveConversation(m.id, m.title || 'Conversa', m.history)
      else if (m.type === 'openHistory') await this.openHistory()
    })
    this.updateContext()
  }

  setLastEditor(ed: vscode.TextEditor) { this.lastEditor = ed }
  private activeEditor(): vscode.TextEditor | undefined {
    return vscode.window.activeTextEditor ?? this.lastEditor
  }

  private model(): string {
    return currentModel(this.ctx)
  }

  /** Contexto do editor ativo: nota para o modelo + chip para a UI. */
  private editorContext(): { note?: string; chip?: { file: string; lang: string; hasSel: boolean } } {
    const c = cfg()
    if (!c.includeActiveFile) return {}
    const ed = this.activeEditor()
    if (!ed) return {}
    const doc = ed.document
    if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') return {}
    const sel = ed.selection
    const lang = doc.languageId
    const rel = vscode.workspace.asRelativePath(doc.uri)
    const hasSel = !sel.isEmpty
    let body = hasSel ? doc.getText(sel) : doc.getText()
    if (body.length > c.maxContextChars) body = body.slice(0, c.maxContextChars) + '\n… (truncado)'
    const note =
      `Contexto do editor — ${hasSel ? 'seleção' : 'arquivo'} \`${rel}\` (${lang}):\n` +
      '```' + lang + '\n' + body + '\n```\n' +
      'Ao propor mudanças, devolva o trecho COMPLETO e pronto para aplicar num único bloco ```' + lang + '.'
    return { note, chip: { file: rel.split('/').pop() || rel, lang, hasSel } }
  }

  updateContext() {
    const { chip } = this.editorContext()
    this.view?.webview.postMessage({ type: 'context', ctx: chip ?? null })
  }

  /** Insere o contexto do editor + as @-refs como system message antes do turno atual. */
  private withContext(history: Msg[]): Msg[] {
    const notes: string[] = []
    const { note } = this.editorContext()
    if (note) notes.push(note)
    if (this.pendingRefs.length) notes.push(...this.pendingRefs)
    // consome as @-refs (valem para um envio)
    this.pendingRefs = []
    this.pendingChips = []
    this.postRefs()
    if (!notes.length) return history
    const copy = history.slice()
    copy.splice(Math.max(0, copy.length - 1), 0, { role: 'system', content: notes.join('\n\n') })
    return copy
  }

  private postRefs() {
    this.view?.webview.postMessage({ type: 'refs', chips: this.pendingChips })
  }

  // ── Histórico de conversas (workspaceState) ──────────────────────────────
  private convKey = 'mangaba.conversations'
  private saveConversation(id: string, title: string, messages: Msg[]) {
    if (messages.filter((m) => m.role !== 'system').length === 0) return
    const list = this.ctx.workspaceState.get<SavedConv[]>(this.convKey, [])
    const rest = list.filter((c) => c.id !== id)
    rest.unshift({ id, title: title.slice(0, 80), messages, ts: Date.now() })
    this.ctx.workspaceState.update(this.convKey, rest.slice(0, 40))
  }
  async openHistory() {
    const list = this.ctx.workspaceState.get<SavedConv[]>(this.convKey, [])
    if (!list.length) { vscode.window.showInformationMessage('Mangaba: nenhuma conversa salva ainda.'); return }
    const pick = await vscode.window.showQuickPick(
      list.map((c) => ({ label: c.title, description: new Date(c.ts).toLocaleString('pt-BR'), id: c.id })),
      { placeHolder: 'Abrir conversa salva' },
    )
    if (!pick) return
    const conv = list.find((c) => c.id === pick.id)
    if (conv) { this.reveal(); this.view?.webview.postMessage({ type: 'loaded', id: conv.id, messages: conv.messages }) }
  }

  // ── @-contexto (quick pick nativo) ───────────────────────────────────────
  async pickContext() {
    const ed = this.activeEditor()
    const opts = [
      { label: '$(file) Arquivo atual', id: 'file' },
      { label: '$(selection) Seleção atual', id: 'sel' },
      { label: '$(warning) Erros do arquivo', id: 'errors' },
      { label: '$(folder-opened) Escolher arquivo…', id: 'pick' },
    ]
    const chosen = await vscode.window.showQuickPick(opts, { placeHolder: 'Adicionar contexto (@) ao próximo envio' })
    if (!chosen) return
    let note = ''
    let chip = ''
    if (chosen.id === 'file' && ed) {
      note = this.fileNote(ed.document, ed.document.getText())
      chip = ed.document.uri.path.split('/').pop() || 'arquivo'
    } else if (chosen.id === 'sel' && ed && !ed.selection.isEmpty) {
      note = this.fileNote(ed.document, ed.document.getText(ed.selection), 'seleção')
      chip = 'seleção'
    } else if (chosen.id === 'errors' && ed) {
      const diags = vscode.languages.getDiagnostics(ed.document.uri)
      if (!diags.length) { vscode.window.showInformationMessage('Sem erros neste arquivo.'); return }
      note = 'Erros (diagnostics) do arquivo:\n' + diags.map((d) => `- linha ${d.range.start.line + 1}: ${d.message}`).join('\n')
      chip = 'erros'
    } else if (chosen.id === 'pick') {
      const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,dist,.git}/**', 400)
      const fp = await vscode.window.showQuickPick(uris.map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u })), { placeHolder: 'Escolher arquivo' })
      if (!fp) return
      const doc = await vscode.workspace.openTextDocument(fp.uri)
      note = this.fileNote(doc, doc.getText())
      chip = fp.label.split('/').pop() || fp.label
    } else { return }
    if (note) { this.pendingRefs.push(note); this.pendingChips.push('@' + chip); this.postRefs() }
  }

  private fileNote(doc: vscode.TextDocument, body: string, kind = 'arquivo'): string {
    const rel = vscode.workspace.asRelativePath(doc.uri)
    const clipped = body.length > cfg().maxContextChars ? body.slice(0, cfg().maxContextChars) + '\n… (truncado)' : body
    return `Contexto (${kind}) \`${rel}\` (${doc.languageId}):\n\`\`\`${doc.languageId}\n${clipped}\n\`\`\``
  }

  /** Substitui um range com diff de revisão opcional. Retorna true se aplicou. */
  async reviewReplace(doc: vscode.TextDocument, range: vscode.Range, newText: string, label: string): Promise<boolean> {
    if (cfg().reviewBeforeApply) {
      const full = doc.getText()
      const modified = full.slice(0, doc.offsetAt(range.start)) + newText + full.slice(doc.offsetAt(range.end))
      const uri = vscode.Uri.parse(`${DIFF_SCHEME}:${label}`).with({ query: String(Date.now()) })
      diffContents.set(uri.toString(), modified)
      await vscode.commands.executeCommand('vscode.diff', doc.uri, uri, `Mangaba — ${label}`)
      const pick = await vscode.window.showInformationMessage('Aplicar a mudança da Mangaba?', 'Aplicar', 'Cancelar')
      diffContents.delete(uri.toString())
      if (pick !== 'Aplicar') return false
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    }
    const we = new vscode.WorkspaceEdit()
    we.replace(doc.uri, range, newText)
    await vscode.workspace.applyEdit(we)
    return true
  }

  /** Aplica um bloco de código no editor ativo (com diff de revisão opcional). */
  private async applyCode(code: string, mode?: string) {
    const ed = this.activeEditor()
    if (!ed) { vscode.window.showWarningMessage('Mangaba: abra um arquivo no editor para aplicar o código.'); return }
    const shown = await vscode.window.showTextDocument(ed.document, { viewColumn: ed.viewColumn, preserveFocus: false })
    const doc = shown.document
    const sel = shown.selection

    // Alvo da edição (range) + novo texto, por modo.
    let range: vscode.Range
    if (mode === 'insert') range = new vscode.Range(sel.active, sel.active)
    else if (mode === 'replaceFile') range = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
    else range = sel.isEmpty ? new vscode.Range(sel.active, sel.active) : sel

    const base = doc.uri.path.split('/').pop() || 'arquivo'
    const ok = await this.reviewReplace(doc, range, code, base)
    if (ok) vscode.window.showInformationMessage('Mangaba: código aplicado (Ctrl/Cmd+Z para desfazer).')
  }

  /** Reescreve um trecho conforme a instrução (não-streaming). Usado por "Editar seleção". */
  async rewrite(lang: string, code: string, instruction: string): Promise<string | null> {
    const sys = `Você reescreve código. Responda APENAS com o código final em ${lang}, sem explicações e sem cercas markdown.`
    const user = `Instrução: ${instruction}\n\nCódigo atual:\n${code}`
    const out = await chatOnce(this.ctx, [{ role: 'system', content: sys }, { role: 'user', content: user }])
    return out ? (stripFences(out) || null) : null
  }

  /** Corrige os erros (diagnostics) de um range/arquivo. */
  async fixDiagnostics(rangeArg?: vscode.Range) {
    const ed = vscode.window.activeTextEditor
    if (!ed) { vscode.window.showInformationMessage('Abra um arquivo.'); return }
    const useSel = !ed.selection.isEmpty
    const target = rangeArg ?? (useSel ? ed.selection : new vscode.Range(ed.document.positionAt(0), ed.document.positionAt(ed.document.getText().length)))
    const diags = vscode.languages.getDiagnostics(ed.document.uri).filter((d) => target.intersection(d.range))
    if (!diags.length) { vscode.window.showInformationMessage('Mangaba: nenhum erro no alvo.'); return }
    const lang = ed.document.languageId
    const code = ed.document.getText(target)
    const problems = diags.map((d) => `- linha ${d.range.start.line + 1}: ${d.message}`).join('\n')
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Mangaba corrigindo os erros…' },
      async () => {
        const out = await chatOnce(this.ctx, [
          { role: 'system', content: `Corrija o código ${lang}. Responda APENAS o código corrigido, sem explicações e sem cercas markdown.` },
          { role: 'user', content: `Erros a corrigir:\n${problems}\n\nCódigo:\n${code}` },
        ])
        if (!out) { vscode.window.showErrorMessage('Mangaba: falha ao corrigir.'); return }
        await this.reviewReplace(ed.document, target, stripFences(out), (ed.document.uri.path.split('/').pop() || 'arquivo') + ' — correção')
      },
    )
  }

  /** Agente: dada uma tarefa, o modelo devolve arquivos completos a criar/alterar. */
  async agentTask(instruction: string): Promise<Array<{ path: string; content: string }>> {
    const c = cfg()
    if (!c.baseUrl) return []
    const parts: string[] = []
    const ed = this.activeEditor()
    if (ed && ed.document.uri.scheme === 'file') {
      parts.push(`Arquivo ativo \`${vscode.workspace.asRelativePath(ed.document.uri)}\` (${ed.document.languageId}):\n\`\`\`\n${ed.document.getText().slice(0, c.maxContextChars)}\n\`\`\``)
    }
    try {
      const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,dist,.git}/**', 80)
      if (uris.length) parts.push('Arquivos do projeto:\n' + uris.map((u) => vscode.workspace.asRelativePath(u)).join('\n'))
    } catch { /* sem workspace */ }

    const sys =
      'Você é um agente de código no VS Code. Para CADA arquivo a criar ou alterar, devolva um bloco EXATAMENTE neste formato:\n' +
      '<<<FILE: caminho/relativo.ext>>>\n<conteúdo COMPLETO do arquivo>\n<<<END>>>\n' +
      'Devolva o arquivo inteiro (não só o trecho). Não escreva nada fora dos blocos.'
    const user = `Tarefa: ${instruction}\n\n${parts.join('\n\n')}`
    try {
      const res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: 'POST', headers: authHeaders(c),
        body: JSON.stringify({
          model: currentModel(this.ctx),
          messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
          temperature: 0.2, max_tokens: c.maxTokens, stream: false,
        }),
      })
      if (!res.ok) return []
      const d = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const text = d.choices?.[0]?.message?.content ?? ''
      const out: Array<{ path: string; content: string }> = []
      const re = /<<<FILE:\s*(.+?)>>>\s*\n([\s\S]*?)<<<END>>>/g
      let mm: RegExpExecArray | null
      while ((mm = re.exec(text))) {
        const path = mm[1].trim().replace(/^["'`]+|["'`]+$/g, '')
        const content = mm[2].replace(/^\s*```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```\s*$/, '')
        if (path) out.push({ path, content })
      }
      return out
    } catch {
      return []
    }
  }

  private async sendModels() {
    const wv = this.view?.webview
    if (!wv) return
    const c = cfg()
    let ids: string[] = []
    if (c.baseUrl) {
      try {
        const res = await fetch(`${c.baseUrl}/models`, { headers: authHeaders(c) })
        if (res.ok) {
          const d = (await res.json()) as { data?: Array<{ id?: string }> }
          ids = (d.data ?? []).map((x) => x.id || '').filter(Boolean)
        }
      } catch { /* offline */ }
    }
    if (!ids.length) ids = [c.model]
    wv.postMessage({ type: 'models', models: ids, current: this.model() })
  }

  focusNew() { this.reveal(); this.view?.webview.postMessage({ type: 'clear' }) }
  sendPrompt(text: string) { this.reveal(); this.view?.webview.postMessage({ type: 'prompt', text }) }
  private reveal() {
    this.view?.show?.(true)
    vscode.commands.executeCommand('mangaba.chatView.focus')
  }

  private async stream(history: Msg[]) {
    const wv = this.view?.webview
    if (!wv) return
    const c = cfg()
    if (!c.baseUrl) { wv.postMessage({ type: 'error', error: 'Defina mangaba.baseUrl nas configurações.' }); return }

    this.abort?.abort()
    this.abort = new AbortController()

    try {
      const res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: 'POST', headers: authHeaders(c),
        body: JSON.stringify({
          model: this.model(), messages: this.withContext(history),
          temperature: c.temperature, max_tokens: c.maxTokens, stream: true,
        }),
        signal: this.abort.signal,
      })

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '')
        wv.postMessage({ type: 'error', error: `HTTP ${res.status} ${detail.slice(0, 160)}` })
        return
      }

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const raw of lines) {
          const line = raw.trim()
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') { wv.postMessage({ type: 'done' }); return }
          try {
            const json = JSON.parse(data)
            const tok = json?.choices?.[0]?.delta?.content
            if (tok) wv.postMessage({ type: 'delta', token: tok })
          } catch { /* partial */ }
        }
      }
      wv.postMessage({ type: 'done' })
    } catch (e) {
      const err = e as { name?: string; message?: string }
      if (err?.name === 'AbortError') { wv.postMessage({ type: 'done' }); return }
      wv.postMessage({ type: 'error', error: err?.message ?? String(e) })
    }
  }

  private html(wv: vscode.Webview): string {
    const nonce = getNonce()
    const scriptUri = wv.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'main.js'))
    const styleUri  = wv.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'main.css'))
    const logoUri   = wv.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'logo.svg'))
    const hljsUri   = wv.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'highlight.min.js'))
    const csp = [
      `default-src 'none'`,
      `img-src ${wv.cspSource} data:`,
      `style-src ${wv.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ')

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
</head>
<body data-logo="${logoUri}">
  <header class="topbar">
    <span class="brand">Mangaba</span>
    <select id="model" class="model-select" title="Escolher modelo"><option>carregando…</option></select>
    <button id="history" class="icon-btn" title="Conversas salvas" aria-label="Conversas salvas">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2 3.5h12V5H2zM2 7.25h12v1.5H2zM2 11h12v1.5H2z"/></svg>
    </button>
  </header>
  <div id="messages" class="messages">
    <div class="empty">
      <img class="logo-img" src="${logoUri}" alt="Mangaba AI" />
      <p class="hint">IA brasileira e soberana, dentro do seu editor.</p>
    </div>
  </div>
  <div id="ctxbar" class="ctxbar"></div>
  <div id="attachments" class="attachments"></div>
  <form id="composer" class="composer">
    <button id="ctxbtn" type="button" class="icon-btn" title="Adicionar contexto (@): arquivo, seleção, erros" aria-label="Adicionar contexto">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 1 0 3.2 13.23.75.75 0 1 0-.68-1.34A5.5 5.5 0 1 1 13.5 8c0 .78-.16 1.25-.4 1.5-.22.24-.53.37-.85.37-.31 0-.5-.1-.62-.25-.13-.17-.13-.4-.13-.62V5.25a.75.75 0 0 0-1.42-.34A3 3 0 1 0 10.6 9.7c.1.2.24.38.42.53.4.34.94.51 1.43.51.7 0 1.4-.28 1.92-.83.53-.57.88-1.4.88-2.41A7 7 0 0 0 8 1Zm0 8.5A1.5 1.5 0 1 1 8 6.5a1.5 1.5 0 0 1 0 3Z"/></svg>
    </button>
    <button id="attach" type="button" class="icon-btn" title="Anexar imagem (use o modelo mangaba-vision-q8)" aria-label="Anexar imagem">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2.5 2A1.5 1.5 0 0 0 1 3.5v9A1.5 1.5 0 0 0 2.5 14h11a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 13.5 2h-11Zm0 1h11a.5.5 0 0 1 .5.5v6.29l-2.4-2.4a.75.75 0 0 0-1.06 0L7.5 10.94 5.96 9.4a.75.75 0 0 0-1.06 0L2 12.3V3.5a.5.5 0 0 1 .5-.5Zm3 1.75A1.25 1.25 0 1 0 5.5 7.25 1.25 1.25 0 0 0 5.5 4.75Z"/></svg>
    </button>
    <textarea id="input" rows="1" placeholder="Pergunte à Mangaba…"></textarea>
    <button id="send" type="submit" class="send-btn" title="Enviar" aria-label="Enviar"></button>
  </form>
  <input id="file" type="file" accept="image/*" hidden />
  <script nonce="${nonce}" src="${hljsUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

/** Autocompletar inline (ghost text). Opt-in — ver mangaba.inlineCompletions. */
class MangabaInline implements vscode.InlineCompletionItemProvider {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const c = cfg()
    if (!c.inlineCompletions || !c.baseUrl) return
    if (document.uri.scheme === DIFF_SCHEME) return

    // Debounce — evita disparar a cada tecla (modelo é lento).
    await new Promise((r) => setTimeout(r, 350))
    if (token.isCancellationRequested) return

    const startLine = Math.max(0, position.line - 80)
    const endLine = Math.min(document.lineCount - 1, position.line + 25)
    const prefix = document.getText(new vscode.Range(new vscode.Position(startLine, 0), position))
    const suffix = document.getText(new vscode.Range(position, new vscode.Position(endLine, document.lineAt(endLine).text.length)))
    if (!prefix.trim()) return

    const lang = document.languageId
    const sys = `Você completa código ${lang}. Responda APENAS com a continuação a partir do ponto do cursor — sem repetir o que já existe, sem explicações e sem cercas markdown.`
    const user = `Complete o código no ponto <CURSOR>.\n--- antes ---\n${prefix}<CURSOR>\n--- depois ---\n${suffix}`

    const controller = new AbortController()
    const sub = token.onCancellationRequested(() => controller.abort())
    try {
      const res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: 'POST', headers: authHeaders(c),
        body: JSON.stringify({
          model: currentModel(this.ctx),
          messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
          temperature: 0.1, max_tokens: 128, stream: false,
        }),
        signal: controller.signal,
      })
      if (!res.ok) return
      const d = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      let text = d.choices?.[0]?.message?.content ?? ''
      text = text.replace(/^\s*```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```\s*$/, '')
      if (!text.trim() || token.isCancellationRequested) return
      return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))]
    } catch {
      return
    } finally {
      sub.dispose()
    }
  }
}

function getNonce() {
  let t = ''
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 24; i++) t += chars.charAt(Math.floor(Math.random() * chars.length))
  return t
}

export function activate(ctx: vscode.ExtensionContext) {
  const provider = new MangabaViewProvider(ctx)

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MangabaViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
      provideTextDocumentContent: (uri) => diffContents.get(uri.toString()) ?? '',
    }),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, new MangabaInline(ctx)),
    vscode.window.onDidChangeActiveTextEditor((ed) => { if (ed) provider.setLastEditor(ed); provider.updateContext() }),
    vscode.window.onDidChangeTextEditorSelection(() => provider.updateContext()),
    vscode.commands.registerCommand('mangaba.openChat', () =>
      vscode.commands.executeCommand('mangaba.chatView.focus')),
    vscode.commands.registerCommand('mangaba.newChat', () => provider.focusNew()),
    vscode.commands.registerCommand('mangaba.explainSelection', () => {
      const ed = vscode.window.activeTextEditor
      if (!ed) { vscode.window.showInformationMessage('Abra um arquivo e selecione um trecho.'); return }
      const code = ed.document.getText(ed.selection)
      if (!code.trim()) { vscode.window.showInformationMessage('Selecione um trecho de código.'); return }
      const lang = ed.document.languageId
      provider.sendPrompt(`Explique este código ${lang} de forma objetiva, em português:\n\n\`\`\`${lang}\n${code}\n\`\`\``)
    }),
    vscode.commands.registerCommand('mangaba.editSelection', async () => {
      const ed = vscode.window.activeTextEditor
      if (!ed || ed.selection.isEmpty) { vscode.window.showInformationMessage('Selecione o código a editar.'); return }
      const instruction = await vscode.window.showInputBox({
        prompt: 'O que a Mangaba deve fazer com a seleção?',
        placeHolder: 'ex.: adicione tratamento de erro e comentários',
      })
      if (!instruction) return
      const lang = ed.document.languageId
      const code = ed.document.getText(ed.selection)
      const selection = ed.selection
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Mangaba editando a seleção…' },
        async () => {
          const out = await provider.rewrite(lang, code, instruction)
          if (out == null) { vscode.window.showErrorMessage('Mangaba: não foi possível gerar a edição.'); return }
          await ed.edit((b) => b.replace(selection, out))
          vscode.window.showInformationMessage('Mangaba: seleção editada (Ctrl/Cmd+Z para desfazer).')
        },
      )
    }),
    vscode.commands.registerCommand('mangaba.agentTask', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]
      if (!folder) { vscode.window.showWarningMessage('Abra uma pasta/projeto para o agente trabalhar.'); return }
      const instruction = await vscode.window.showInputBox({
        prompt: 'Descreva a tarefa — a Mangaba vai propor edições em arquivos',
        placeHolder: 'ex.: crie um util de validação de email e use no formulário',
      })
      if (!instruction) return

      const files = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Mangaba (agente) planejando as edições…' },
        () => provider.agentTask(instruction),
      )
      if (!files.length) {
        vscode.window.showWarningMessage('Mangaba: o agente não retornou edições (o modelo pode ter estourado o contexto — tente uma tarefa mais específica).')
        return
      }

      let applied = 0
      for (const f of files) {
        const uri = vscode.Uri.joinPath(folder.uri, f.path)
        let existing = ''
        let isNew = false
        try { existing = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8') } catch { isNew = true }

        // Diff de revisão (documentos virtuais dos dois lados).
        const stamp = Date.now() + '-' + applied
        const leftUri  = vscode.Uri.parse(`${DIFF_SCHEME}:${f.path} (atual)`).with({ query: stamp + 'L' })
        const rightUri = vscode.Uri.parse(`${DIFF_SCHEME}:${f.path} (proposto)`).with({ query: stamp + 'R' })
        diffContents.set(leftUri.toString(), existing)
        diffContents.set(rightUri.toString(), f.content)
        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `Mangaba — ${f.path}${isNew ? '  (novo arquivo)' : ''}`)
        const pick = await vscode.window.showInformationMessage(`Aplicar ${f.path}?`, 'Aplicar', 'Pular')
        diffContents.delete(leftUri.toString())
        diffContents.delete(rightUri.toString())

        if (pick === 'Aplicar') {
          const we = new vscode.WorkspaceEdit()
          if (isNew) {
            we.createFile(uri, { overwrite: true, contents: Buffer.from(f.content, 'utf8') })
          } else {
            const doc = await vscode.workspace.openTextDocument(uri)
            we.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), f.content)
          }
          await vscode.workspace.applyEdit(we)
          await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
          applied++
        }
      }
      vscode.window.showInformationMessage(`Mangaba (agente): ${applied} de ${files.length} arquivo(s) aplicado(s).`)
    }),
    vscode.commands.registerCommand('mangaba.pickContext', () => provider.pickContext()),
    vscode.commands.registerCommand('mangaba.openHistory', () => provider.openHistory()),
    vscode.commands.registerCommand('mangaba.fixDiagnostics', (range?: vscode.Range) => provider.fixDiagnostics(range)),
    vscode.commands.registerCommand('mangaba.generateTests', async () => {
      const ed = vscode.window.activeTextEditor
      if (!ed) { vscode.window.showInformationMessage('Abra um arquivo.'); return }
      const code = ed.selection.isEmpty ? ed.document.getText() : ed.document.getText(ed.selection)
      const lang = ed.document.languageId
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Mangaba gerando testes…' },
        async () => {
          const out = await chatOnce(ctx, [
            { role: 'system', content: `Você escreve testes automatizados em ${lang}. Responda APENAS o código de teste, sem explicações e sem cercas markdown.` },
            { role: 'user', content: `Gere testes para:\n${code}` },
          ])
          if (!out) { vscode.window.showErrorMessage('Mangaba: falha ao gerar testes.'); return }
          const doc = await vscode.workspace.openTextDocument({ content: stripFences(out), language: lang })
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside)
        },
      )
    }),
    vscode.commands.registerCommand('mangaba.commitMessage', async () => {
      const gitExt = vscode.extensions.getExtension('vscode.git')
      if (!gitExt) { vscode.window.showWarningMessage('Extensão Git não encontrada.'); return }
      if (!gitExt.isActive) await gitExt.activate()
      const api = gitExt.exports.getAPI(1)
      const repo = api.repositories[0]
      if (!repo) { vscode.window.showWarningMessage('Nenhum repositório Git aberto.'); return }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: 'Mangaba: mensagem de commit…' },
        async () => {
          let diff: string = await repo.diff(true).catch(() => '')
          if (!diff) diff = await repo.diff(false).catch(() => '')
          if (!diff) { vscode.window.showInformationMessage('Sem mudanças para descrever.'); return }
          const out = await chatOnce(ctx, [
            { role: 'system', content: 'Gere UMA mensagem de commit concisa (Conventional Commits, imperativa, em português). Responda só a mensagem, sem aspas nem explicação.' },
            { role: 'user', content: diff.slice(0, cfg().maxContextChars) },
          ], 0.3)
          if (!out) { vscode.window.showErrorMessage('Mangaba: falha ao gerar a mensagem.'); return }
          repo.inputBox.value = out.trim().replace(/^["'`]+|["'`]+$/g, '')
          vscode.commands.executeCommand('workbench.view.scm')
        },
      )
    }),
    vscode.languages.registerCodeActionsProvider('*', {
      provideCodeActions(_doc, range, context) {
        if (!context.diagnostics.length) return
        const action = new vscode.CodeAction('🥭 Corrigir com Mangaba', vscode.CodeActionKind.QuickFix)
        action.command = { command: 'mangaba.fixDiagnostics', title: 'Corrigir com Mangaba', arguments: [range] }
        return [action]
      },
    }),
  )
}

export function deactivate() {}
