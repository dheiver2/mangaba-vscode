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

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.lastEditor = vscode.window.activeTextEditor
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view
    view.webview.options = { enableScripts: true, localResourceRoots: [this.ctx.extensionUri] }
    view.webview.html = this.html(view.webview)
    view.webview.onDidReceiveMessage(async (m: { type: string; history?: Msg[]; model?: string; code?: string; mode?: string }) => {
      if (m.type === 'send' && m.history) await this.stream(m.history)
      else if (m.type === 'stop') this.abort?.abort()
      else if (m.type === 'getModels') await this.sendModels()
      else if (m.type === 'setModel' && m.model) await this.ctx.globalState.update('mangaba.model', m.model)
      else if (m.type === 'apply' && typeof m.code === 'string') await this.applyCode(m.code, m.mode)
      else if (m.type === 'getContext') this.updateContext()
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

  /** Insere o contexto do editor como system message antes do turno atual. */
  private withContext(history: Msg[]): Msg[] {
    const { note } = this.editorContext()
    if (!note) return history
    const copy = history.slice()
    copy.splice(Math.max(0, copy.length - 1), 0, { role: 'system', content: note })
    return copy
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

    const doApply = async () => {
      const we = new vscode.WorkspaceEdit()
      we.replace(doc.uri, range, code)
      await vscode.workspace.applyEdit(we)
      vscode.window.showInformationMessage('Mangaba: código aplicado (Ctrl/Cmd+Z para desfazer).')
    }

    if (!cfg().reviewBeforeApply) { await doApply(); return }

    // Diff de revisão: mostra atual × proposto e pede confirmação.
    const full = doc.getText()
    const modified = full.slice(0, doc.offsetAt(range.start)) + code + full.slice(doc.offsetAt(range.end))
    const base = doc.uri.path.split('/').pop() || 'arquivo'
    const proposedUri = vscode.Uri.parse(`${DIFF_SCHEME}:${base} (proposto)`).with({ query: String(Date.now()) })
    diffContents.set(proposedUri.toString(), modified)
    await vscode.commands.executeCommand('vscode.diff', doc.uri, proposedUri, `Mangaba — revisar: ${base}  (◀ atual | proposto ▶)`)
    const pick = await vscode.window.showInformationMessage('Aplicar a mudança da Mangaba?', 'Aplicar', 'Cancelar')
    diffContents.delete(proposedUri.toString())
    if (pick === 'Aplicar') {
      await doApply()
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    }
  }

  /** Reescreve um trecho conforme a instrução (não-streaming). Usado por "Editar seleção". */
  async rewrite(lang: string, code: string, instruction: string): Promise<string | null> {
    const c = cfg()
    if (!c.baseUrl) return null
    const sys = `Você reescreve código. Responda APENAS com o código final em ${lang}, sem explicações e sem cercas markdown.`
    const user = `Instrução: ${instruction}\n\nCódigo atual:\n${code}`
    try {
      const res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: 'POST', headers: authHeaders(c),
        body: JSON.stringify({
          model: this.model(),
          messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
          temperature: 0.2, max_tokens: c.maxTokens, stream: false,
        }),
      })
      if (!res.ok) return null
      const d = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      let out = d.choices?.[0]?.message?.content ?? ''
      out = out.replace(/^\s*```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```\s*$/, '').replace(/\s+$/, '')
      return out || null
    } catch { return null }
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
    <button id="attach" type="button" class="icon-btn" title="Anexar imagem (use o modelo mangaba-vision-q8)" aria-label="Anexar imagem">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2.5 2A1.5 1.5 0 0 0 1 3.5v9A1.5 1.5 0 0 0 2.5 14h11a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 13.5 2h-11Zm0 1h11a.5.5 0 0 1 .5.5v6.29l-2.4-2.4a.75.75 0 0 0-1.06 0L7.5 10.94 5.96 9.4a.75.75 0 0 0-1.06 0L2 12.3V3.5a.5.5 0 0 1 .5-.5Zm3 1.75A1.25 1.25 0 1 0 5.5 7.25 1.25 1.25 0 0 0 5.5 4.75Z"/></svg>
    </button>
    <textarea id="input" rows="1" placeholder="Pergunte à Mangaba…"></textarea>
    <button id="send" type="submit" class="send-btn" title="Enviar" aria-label="Enviar"></button>
  </form>
  <input id="file" type="file" accept="image/*" hidden />
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
  )
}

export function deactivate() {}
