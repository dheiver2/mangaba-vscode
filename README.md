# Mangaba AI para VS Code

[![Version](https://img.shields.io/badge/version-0.11.2-E94A12)](https://github.com/dheiver2/mangaba-vscode)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.85%2B-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![Soberano](https://img.shields.io/badge/dados-100%25%20na%20sua%20infra-3DA639)](https://mangaba.chat)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Feito no Brasil](https://img.shields.io/badge/Feito%20no-Brasil-009B3A)](https://mangaba.chat)

**O copiloto de IA brasileiro e soberano — dentro do seu VS Code.**
Chat, edição de código, agente autônomo e busca no repositório usando os modelos **self-hosted** da Mangaba (OpenAI-compatível). Seu código **não sai da sua infraestrutura**.

---

## Por que Mangaba

Copilot, Cursor e Cody são excelentes — mas mandam seu código para servidores de terceiros. A Mangaba entrega a mesma experiência **on-premises**, onde eles não podem ir:

- **Soberania total** — roda no seu servidor; nada trafega para fora. Ideal para governo, bancos, saúde, jurídico e defesa.
- **Sem lock-in** — endpoint OpenAI-compatível; troque de modelo sem reescrever nada.
- **LGPD por construção** — as chamadas saem do *host* da extensão (Node), não do navegador; sem CORS, sem expor credenciais.
- **Custo previsível** — sua infra, seu controle.

---

## Recursos em um relance

| Categoria | O que faz |
| --- | --- |
| **Chat** | Painel na Activity Bar com streaming, markdown e **syntax highlighting**; seletor de modelo ao vivo; histórico de conversas. |
| **Visão** | Anexe ou cole imagens e pergunte sobre elas (modelo multimodal). |
| **Editar código** | Botões **Aplicar / Inserir / Copiar** em cada bloco; **diff de revisão** antes de aplicar; **Editar seleção** por instrução (`Ctrl/Cmd+Alt+K`). |
| **Agente autônomo** | Planeja, lê, edita, **roda comandos no terminal (com aprovação)** e **verifica rodando os testes** — em laço, com **checkpoints/rollback**. |
| **RAG @codebase** | Indexa o repositório com **embeddings locais** e injeta os trechos relevantes automaticamente. |
| **Integrações** | **MCP** (conecte ferramentas externas) e **Git** (gera a mensagem de commit a partir do diff). |
| **Produtividade** | Corrigir erros pela lâmpada, gerar testes, explicar seleção, `@`-contexto, autocompletar inline (opt-in). |

---

## Início rápido

1. Instale a extensão e abra o ícone **Mangaba AI** na Activity Bar (ou `Ctrl/Cmd+Alt+M`).
2. Em **Configurações → Extensions → Mangaba AI**, defina **`mangaba.baseUrl`** com o seu servidor (endpoint OpenAI-compatível terminando em `/v1`).
3. Escolha o **modelo** no seletor do topo do painel.
4. Converse. Para trazer o código junto, deixe o arquivo aberto (contexto automático) ou use o botão **`@`**.
5. Selecione um trecho e use o menu de contexto: **Explicar**, **Editar (IA)** ou **Gerar testes**.

---

## Agente autônomo

Rode **"Mangaba AI: Agente autônomo (tarefa)"** e descreva o objetivo. O agente:

1. **Planeja** os passos.
2. Age em laço com as ferramentas `list` · `read` · `write` · `run` · `mcp` · `done`.
3. **Executa comandos** no terminal — sempre com **aprovação** (bloqueia comandos perigosos).
4. **Auto-verifica**: roda os testes, lê a saída e corrige se falhar.
5. Toda edição passa por **diff de revisão**; a sessão inteira pode ser desfeita em **"Desfazer sessão do agente"**.

Dica: informe `mangaba.testCommand` (ex.: `npm test`, `pytest`) para o agente saber como validar.

---

## RAG @codebase (busca no repositório)

Rode **"Mangaba AI: Indexar projeto"** e o chat passa a recuperar os trechos mais relevantes do seu código automaticamente. Dois backends de embeddings:

| Backend | Quando usar |
| --- | --- |
| `transformers` | Build self-contained: embeddings **100% locais e embutidos** (nada externo). |
| `ollama` | Build leve/multiplataforma: usa o Ollama local (`ollama pull nomic-embed-text`). |

Configure em `mangaba.embeddingsBackend`. Em ambos, **nada sai da máquina**.

---

## MCP (ferramentas externas)

Conecte servidores **Model Context Protocol** e o agente usa as ferramentas deles:

```jsonc
"mangaba.mcpServers": [
  { "name": "fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
]
```

---

## Comandos e atalhos

| Comando | Atalho |
| --- | --- |
| Mangaba AI: Abrir chat | `Ctrl/Cmd+Alt+M` |
| Mangaba AI: Editar seleção (IA) | `Ctrl/Cmd+Alt+K` |
| Mangaba AI: Explicar seleção | `Ctrl/Cmd+Alt+E` |
| Agente autônomo · Tarefa no projeto · Indexar projeto | Paleta de comandos |
| Gerar testes · Corrigir erros com IA · Gerar mensagem de commit | Menu de contexto / SCM / lâmpada |
| Autocompletar inline | `Alt+\` (opt-in) |

---

## Configuração

| Configuração | Padrão | Descrição |
| --- | --- | --- |
| `mangaba.baseUrl` | — | Endpoint OpenAI-compatível do **seu** servidor Mangaba. |
| `mangaba.model` | `mangaba-pro` | Modelo inicial (o seletor do chat sobrepõe). |
| `mangaba.apiKey` | — | Bearer token (opcional). |
| `mangaba.temperature` / `mangaba.maxTokens` | `0.7` / `4096` | Amostragem e limite de resposta. |
| `mangaba.includeActiveFile` / `mangaba.maxContextChars` | `true` / `6000` | Contexto do arquivo ativo. |
| `mangaba.reviewBeforeApply` | `true` | Diff de revisão antes de aplicar. |
| `mangaba.useCodebaseContext` / `mangaba.embeddingsBackend` | `true` / `transformers` | RAG @codebase e backend de embeddings. |
| `mangaba.commandApproval` / `mangaba.testCommand` / `mangaba.agentMaxSteps` | `always` / — / `12` | Agente autônomo. |
| `mangaba.mcpServers` | `[]` | Servidores MCP. |
| `mangaba.inlineCompletions` | `false` | Autocompletar inline (ghost text). |

---

## Privacidade e soberania

Nada é enviado a terceiros — **apenas ao endpoint que você configurar**. Embeddings do RAG rodam localmente. Sem telemetria. O código que você escreve permanece na sua infraestrutura.

## Requisitos

- VS Code **1.85+**.
- Um servidor Mangaba (ou qualquer endpoint **OpenAI-compatível**) em `mangaba.baseUrl`.
- Opcional: **Ollama** para o RAG na build leve; **Git** para a mensagem de commit.

## FAQ

**Preciso de internet?** Só entre a extensão e o **seu** servidor. Nada vai para nuvens de terceiros.

**Funciona com qualquer modelo?** Sim — qualquer endpoint OpenAI-compatível (Mangaba, vLLM, Ollama, LM Studio, etc.).

**É seguro rodar o agente?** Sim: todo comando pede **aprovação**, comandos perigosos são bloqueados e cada edição tem **diff + rollback**.

**Por que o modelo às vezes trava em tarefas grandes?** Os modelos menores têm janela de contexto limitada; use seleção/`@`-contexto e um modelo de contexto maior no servidor para tarefas amplas.

## Publicar novas versões

O CI publica na Marketplace ao empurrar uma tag `vX.Y.Z` (precisa do secret **`VSCE_PAT`** no repositório):

```bash
npm version patch          # sobe a versão no package.json e cria o commit/tag
git push --follow-tags     # dispara o workflow: publica por plataforma + build universal
```

Ou publique manualmente: `npx @vscode/vsce publish --no-dependencies`.

## Desenvolvimento

```bash
npm install
npm run build        # ou: npm run watch  (F5 abre o Extension Development Host)
npm run package      # gera o .vsix
```

---

<div align="center"><sub><b>Mangaba AI</b> · Feito no Brasil · <a href="https://mangaba.chat">mangaba.chat</a></sub></div>
