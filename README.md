<div align="center">
  <img src="media/icon-128.png" alt="Mangaba AI" width="96" />

  # Mangaba AI para VS Code

  **A IA brasileira e soberana — dentro do seu editor.**

  Chat com os modelos **self-hosted** da Mangaba (OpenAI-compatível), com seletor de modelo, streaming e explicação de código. Sem provedor estrangeiro, sem lock-in.
</div>

---

## ✨ Recursos

- **💬 Chat com streaming** — painel dedicado na Activity Bar (ícone 🥭), respostas em tempo real com markdown e blocos de código.
- **🧠 Seletor de modelo ao vivo** — lista os modelos direto do seu servidor (`/v1/models`): `mangaba-pro`, `mangaba-max`, `mangaba-lite-q4`, `mangaba-vision-q8`. Troque a qualquer momento; a escolha persiste.
- **🔍 Explicar seleção** — selecione um trecho → botão direito → *"Mangaba AI: Explicar seleção"* (ou o atalho). A extensão manda o código + a linguagem e explica em português.
- **🔒 Soberano por padrão** — as chamadas saem do **host da extensão** (Node), não do webview: sem CORS e sem expor a URL/credencial no cliente.
- **🎨 Nativo do tema** — a UI usa as cores do seu tema do VS Code (claro/escuro), com acento laranja da marca.
- **♿ Acessível** — respeita `prefers-reduced-motion`, foco por teclado e Enter/Shift+Enter no compositor.

## 🚀 Uso

1. Clique no ícone **🥭 Mangaba AI** na Activity Bar (ou `Cmd/Ctrl+Alt+M`).
2. Escolha o **modelo** no seletor do topo.
3. Digite e envie (**Enter** envia, **Shift+Enter** quebra linha).
4. Para explicar código: selecione no editor → **botão direito → Mangaba AI: Explicar seleção**.
5. **+** no topo do painel = nova conversa.

## ⚙️ Configuração

| Configuração | Padrão | Descrição |
|---|---|---|
| `mangaba.baseUrl` | `…/v1` | Endpoint OpenAI-compatível do servidor Mangaba. |
| `mangaba.model` | `mangaba-pro` | Modelo inicial (o seletor do chat sobrepõe). |
| `mangaba.apiKey` | — | Bearer token (opcional — o self-hosted é keyless). |
| `mangaba.temperature` | `0.7` | Temperatura de amostragem. |
| `mangaba.maxTokens` | `4096` | Máximo de tokens na resposta. |

Ajuste em **Settings → Extensions → Mangaba AI**.

## ⌨️ Comandos & atalhos

| Comando | Atalho |
|---|---|
| Mangaba AI: Abrir chat | `Cmd/Ctrl+Alt+M` |
| Mangaba AI: Explicar seleção | `Cmd/Ctrl+Alt+E` (com seleção) |
| Nova conversa | botão `+` no painel |

## 🏗️ Arquitetura

```
VS Code ──webview (media/main.js)──► extension host (src/extension.ts)
                                          │  fetch + SSE (stream)
                                          ▼
                          Servidor Mangaba  /v1/chat/completions · /v1/models
```

- Streaming SSE parseado no host e repassado ao webview por `postMessage`.
- Seletor populado por `GET {baseUrl}/models`; escolha persistida em `globalState`.
- Build via **esbuild** → `dist/extension.js`.

## 🛠️ Desenvolvimento

```bash
npm install
npm run build          # ou: npm run watch
# F5 no VS Code → Extension Development Host
npm run package        # gera o .vsix (@vscode/vsce)
```

## 🔐 Privacidade

Nada é enviado a terceiros: apenas ao **seu** endpoint Mangaba (`mangaba.baseUrl`). Sem telemetria.

---

<div align="center">
  <sub>Feito no Brasil 🇧🇷 · <a href="https://mangaba.chat">mangaba.chat</a></sub>
</div>
