# Mangaba AI — extensão do VS Code

Chat com a **Mangaba AI** (IA brasileira e soberana) direto no VS Code. Conversa com os modelos self-hosted da Mangaba via endpoint **OpenAI-compatível** — sem depender de provedor estrangeiro.

## Recursos
- 💬 Painel de chat na Activity Bar (ícone da Mangaba), com **streaming**.
- 🧠 Explicar código: selecione um trecho → botão direito → **"Mangaba AI: Explicar seleção"**.
- 🔁 Nova conversa pelo botão `+` no topo do painel.
- ⚙️ Configurável: `mangaba.baseUrl`, `mangaba.model`, `mangaba.apiKey`, `mangaba.temperature`, `mangaba.maxTokens`.
- 🔒 As chamadas ao modelo saem do **host da extensão** (Node), não do webview — sem CORS e sem expor a URL no cliente.

## Rodar em desenvolvimento
```bash
npm install
npm run build      # ou: npm run watch
```
Depois abra a pasta no VS Code e tecle **F5** (Run Extension) — abre uma janela "Extension Development Host" com a extensão carregada. O ícone 🥭 aparece na Activity Bar.

## Empacotar (.vsix)
```bash
npm run package    # gera mangaba-ai-0.1.0.vsix (via @vscode/vsce)
```
Instale com: `code --install-extension mangaba-ai-0.1.0.vsix`.

## Configuração padrão
Aponta para o servidor Mangaba OpenAI-compatível (keyless). Ajuste em
**Settings → Extensions → Mangaba AI** ou no `settings.json`:
```json
{
  "mangaba.baseUrl": "https://SEU-SERVIDOR/v1",
  "mangaba.model": "mangaba-pro"
}
```

## Arquitetura
- `src/extension.ts` — registra a view (webview) + comandos; faz o streaming SSE de `/v1/chat/completions`.
- `media/main.js` / `media/main.css` — UI do chat no webview (markdown mínimo, dots de digitação, tema do VS Code).
- Build via `esbuild` → `dist/extension.js`.
