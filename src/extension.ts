import * as vscode from 'vscode'

interface Msg { role: 'system' | 'user' | 'assistant'; content: string }

function cfg() {
  const c = vscode.workspace.getConfiguration('mangaba')
  return {
    baseUrl:     (c.get<string>('baseUrl') || '').replace(/\/+$/, ''),
    model:       c.get<string>('model') || 'mangaba-pro',
    apiKey:      c.get<string>('apiKey') || '',
    temperature: c.get<number>('temperature') ?? 0.7,
    maxTokens:   c.get<number>('maxTokens') ?? 4096,
  }
}

class MangabaViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'mangaba.chatView'
  private view?: vscode.WebviewView
  private abort?: AbortController

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view
    view.webview.options = { enableScripts: true, localResourceRoots: [this.ctx.extensionUri] }
    view.webview.html = this.html(view.webview)
    view.webview.onDidReceiveMessage(async (m: { type: string; history?: Msg[]; model?: string }) => {
      if (m.type === 'send' && m.history) await this.stream(m.history)
      else if (m.type === 'stop') this.abort?.abort()
      else if (m.type === 'getModels') await this.sendModels()
      else if (m.type === 'setModel' && m.model) await this.ctx.globalState.update('mangaba.model', m.model)
    })
  }

  /** Modelo ativo: o que o usuário escolheu (persistido) ou o default da config. */
  private model(): string {
    return this.ctx.globalState.get<string>('mangaba.model') || cfg().model
  }

  /** Busca os modelos disponíveis no servidor Mangaba (/v1/models) e envia ao webview. */
  private async sendModels() {
    const wv = this.view?.webview
    if (!wv) return
    const c = cfg()
    let ids: string[] = []
    if (c.baseUrl) {
      try {
        const res = await fetch(`${c.baseUrl}/models`, {
          headers: {
            'ngrok-skip-browser-warning': '1',
            ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
          },
        })
        if (res.ok) {
          const d = (await res.json()) as { data?: Array<{ id?: string }> }
          ids = (d.data ?? []).map((x) => x.id || '').filter(Boolean)
        }
      } catch { /* offline / sem modelos — usa fallback */ }
    }
    if (!ids.length) ids = [c.model]
    wv.postMessage({ type: 'models', models: ids, current: this.model() })
  }

  /** Abre o painel e limpa a conversa. */
  focusNew() {
    this.reveal()
    this.view?.webview.postMessage({ type: 'clear' })
  }

  /** Abre o painel e injeta um prompt (auto-envia no webview). */
  sendPrompt(text: string) {
    this.reveal()
    this.view?.webview.postMessage({ type: 'prompt', text })
  }

  private reveal() {
    this.view?.show?.(true)
    vscode.commands.executeCommand('mangaba.chatView.focus')
  }

  /** Faz o streaming do endpoint OpenAI-compatível do Mangaba no host (sem CORS). */
  private async stream(history: Msg[]) {
    const wv = this.view?.webview
    if (!wv) return
    const c = cfg()
    if (!c.baseUrl) { wv.postMessage({ type: 'error', error: 'Defina mangaba.baseUrl nas configurações.' }); return }

    this.abort?.abort()
    this.abort = new AbortController()

    try {
      const res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': '1',
          ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model(), messages: history,
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
          } catch { /* keep-alive / partial */ }
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
    <span class="brand">🥭 Mangaba</span>
    <select id="model" class="model-select" title="Escolher modelo"><option>carregando…</option></select>
  </header>
  <div id="messages" class="messages">
    <div class="empty">
      <img class="logo-img" src="${logoUri}" alt="Mangaba AI" />
      <p class="hint">IA brasileira e soberana, dentro do seu editor.</p>
    </div>
  </div>
  <form id="composer" class="composer">
    <textarea id="input" rows="1" placeholder="Pergunte à Mangaba…  (Enter envia, Shift+Enter quebra linha)"></textarea>
    <button id="send" type="submit" title="Enviar" aria-label="Enviar">➤</button>
  </form>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
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
  )
}

export function deactivate() {}
