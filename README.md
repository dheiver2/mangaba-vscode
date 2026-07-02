# Mangaba AI para VS Code

[![Version](https://img.shields.io/badge/version-0.9.0-E94A12)](https://github.com/dheiver2/mangaba-vscode)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.85%2B-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-3DA639)](LICENSE)
[![Feito no Brasil](https://img.shields.io/badge/Feito%20no-Brasil-009B3A)](https://mangaba.chat)

**A IA brasileira e soberana — dentro do seu editor.** Chat com os modelos self-hosted da Mangaba (OpenAI-compatível), com seletor de modelo ao vivo, streaming, visão e explicação de código. Sem provedor estrangeiro, sem lock-in.

## Recursos

- **Chat com streaming** — painel dedicado na Activity Bar, respostas em tempo real com markdown e blocos de código.
- **Seletor de modelo ao vivo** — lista os modelos direto do seu servidor (`/v1/models`): `mangaba-pro`, `mangaba-max`, `mangaba-lite-q4`, `mangaba-vision-q8`. Troca a qualquer momento; a escolha persiste.
- **Visão (multimodal)** — anexe ou cole uma imagem e pergunte sobre ela (com o modelo `mangaba-vision-q8`).
- **Editar código pelo chat** — o assistente enxerga o **arquivo/seleção ativos** e cada bloco de código da resposta ganha botões **Aplicar / Inserir / Copiar** direto no editor.
- **Diff de revisão** — antes de aplicar, mostra um **diff (atual × proposto)** para você aceitar ou rejeitar (como no Cursor). Desativável em `mangaba.reviewBeforeApply`.
- **Autocompletar inline (ghost text)** — sugestões enquanto você digita (opt-in em `mangaba.inlineCompletions`; melhor com endpoint rápido).
- **Agente multi-arquivo** — *Tarefa no projeto (agente)*: descreva uma tarefa e a Mangaba propõe edições em **vários arquivos** (criar/alterar), cada uma revisada em diff antes de aplicar.
- **Editar seleção (IA)** — selecione um trecho, descreva a mudança (`Ctrl/Cmd+Alt+K`) e a Mangaba reescreve e aplica no lugar.
- **Histórico de conversas** — salva e retoma conversas (botão no topo do painel).
- **Corrigir erros com IA** — a lâmpada 💡 oferece *Corrigir com Mangaba* nos erros do editor.
- **Gerar testes** e **mensagem de commit** — comandos prontos (o commit preenche o Source Control a partir do `git diff`).
- **RAG @codebase** — *Indexar projeto* embeda o repositório com **embeddings 100% locais** (transformers.js); o chat recupera automaticamente os trechos relevantes. Nada sai da máquina.
- **@-contexto** — botão `@` no compositor adiciona arquivo, seleção, erros ou um arquivo escolhido como contexto.
- **Explicar seleção** — selecione um trecho no editor e explique em português (menu de contexto ou atalho).
- **Soberano por padrão** — as chamadas saem do host da extensão (Node), não do webview: sem CORS e sem expor URL/credencial no cliente.
- **Nativo do tema** — usa as cores do seu tema do VS Code (claro/escuro), com acento laranja da marca.

## Uso

1. Clique no ícone **Mangaba AI** na Activity Bar (ou `Ctrl/Cmd+Alt+M`).
2. Escolha o **modelo** no seletor do topo.
3. Digite e envie (**Enter** envia, **Shift+Enter** quebra linha).
4. **Imagem:** clique no ícone de imagem (ou cole) e selecione `mangaba-vision-q8`.
5. **Código:** selecione no editor e use **Explicar seleção** (menu de contexto).

## Configuração

| Configuração | Padrão | Descrição |
| --- | --- | --- |
| `mangaba.baseUrl` | `.../v1` | Endpoint OpenAI-compatível do servidor Mangaba. |
| `mangaba.model` | `mangaba-pro` | Modelo inicial (o seletor do chat sobrepõe). |
| `mangaba.apiKey` | — | Bearer token (opcional — o self-hosted é keyless). |
| `mangaba.temperature` | `0.7` | Temperatura de amostragem (0–2). |
| `mangaba.maxTokens` | `4096` | Máximo de tokens na resposta. |

## Comandos e atalhos

| Comando | Atalho |
| --- | --- |
| Mangaba AI: Abrir chat | `Ctrl/Cmd+Alt+M` |
| Mangaba AI: Editar seleção (IA) | `Ctrl/Cmd+Alt+K` (com seleção) |
| Mangaba AI: Explicar seleção | `Ctrl/Cmd+Alt+E` (com seleção) |
| Nova conversa | botão no topo do painel |

## Arquitetura

```
VS Code  ──webview (media/main.js)──►  extension host (src/extension.ts)
                                            │  fetch + SSE (stream)
                                            ▼
                        Servidor Mangaba   /v1/chat/completions · /v1/models
```

- Streaming SSE parseado no host e repassado ao webview via `postMessage`.
- Seletor populado por `GET {baseUrl}/models`; escolha persistida em `globalState`.
- Build via esbuild em `dist/extension.js`.

## Desenvolvimento

```bash
npm install
npm run build        # ou: npm run watch  (F5 abre o Extension Development Host)
npm run package      # gera o .vsix
```

## Privacidade

Nada é enviado a terceiros — apenas ao seu endpoint Mangaba (`mangaba.baseUrl`). Sem telemetria.

---

Feito no Brasil · [mangaba.chat](https://mangaba.chat)
