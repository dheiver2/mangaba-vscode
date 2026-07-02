# Mangaba AI para VS Code

[![Version](https://img.shields.io/visual-studio-marketplace/v/mangaba-ai.mangaba-ai?label=marketplace&color=E94A12)](https://marketplace.visualstudio.com/items?itemName=mangaba-ai.mangaba-ai)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/mangaba-ai.mangaba-ai?color=3DA639)](https://marketplace.visualstudio.com/items?itemName=mangaba-ai.mangaba-ai)
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
| **Chat** | Painel na Activity Bar com streaming, markdown e **syntax highlighting**; seletor de modelo ao vivo; histórico de conversas. **Regenerar/editar/copiar** mensagens, **comandos `/`**, **exportar em Markdown**, contador de tokens e **status do servidor** na barra inferior. |
| **Anexos & análise de arquivos** | **Arraste, cole ou anexe** qualquer arquivo — código, texto, JSON/CSV, logs, **PDF** (texto extraído automaticamente) e **imagens** (visão). Vários de uma vez, com chips por tipo. |
| **Editar código** | Botões **Aplicar / Inserir / Copiar** em cada bloco; **diff de revisão** antes de aplicar; **Editar seleção** por instrução (`Ctrl/Cmd+Alt+K`). |
| **Agente autônomo** | Planeja, lê, edita, **roda comandos no terminal (com aprovação)** e **verifica rodando os testes** — em laço, com **checkpoints/rollback**. |
| **RAG @codebase** | Indexa o repositório com **embeddings locais** e injeta os trechos relevantes automaticamente. |
| **Integrações** | **MCP** (conecte ferramentas externas) e **Git** (gera a mensagem de commit a partir do diff). |
| **Produtividade** | Corrigir erros pela lâmpada, gerar testes, explicar seleção, `@`-contexto, autocompletar inline (opt-in). |

---

## Início rápido

**Funciona de fábrica** — a extensão já vem conectada ao servidor Mangaba, sem configurar nada.

1. Instale a extensão e abra o ícone **Mangaba AI** na Activity Bar (ou `Ctrl/Cmd+Alt+M`).
2. Escolha o **modelo** no seletor do topo do painel e converse — digite **`/`** para ver os comandos rápidos.
3. Para trazer o código junto, deixe o arquivo aberto (contexto automático), use o botão **`@`** ou **arraste arquivos** para o chat.
4. Selecione um trecho e use o menu de contexto: **Explicar**, **Editar (IA)** ou **Gerar testes**.
5. *(Opcional, empresas)* aponte `mangaba.baseUrl` para o **seu** servidor OpenAI-compatível — soberania total.

O ícone **Mangaba na barra de status** (canto inferior) mostra se o servidor está online e qual modelo está ativo.

---

## Anexar e analisar arquivos

Três formas de anexar (como nas grandes IAs):

- **Arraste e solte** arquivos sobre o campo de mensagem;
- **Cole** (`Ctrl/Cmd+V`) um arquivo ou imagem da área de transferência;
- Clique no **clipe** para escolher no seletor do sistema (vários de uma vez).

A análise é feita **no host** conforme o tipo:

| Tipo | O que acontece |
| --- | --- |
| Código / texto / JSON / CSV / logs | Conteúdo lido e enviado ao modelo (com nome do arquivo e linguagem). |
| **PDF** | Texto **extraído automaticamente** (resolve fontes/encodings via pdfjs; parser próprio como reserva). |
| **Imagem** | Enviada ao modelo de **visão** (use `mangaba-vision-q8`). |
| Binário | Anexado como referência (metadados), sinalizado como não analisável. |

Arquivos de texto grandes são truncados para caber na janela de contexto (com aviso no chip). Tudo roda localmente/no seu servidor — **nada vai para terceiros**.

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
| Nova conversa · Exportar conversa (Markdown) | Botões no topo do painel |
| Comandos de barra no chat (`/explain`, `/tests`, `/doc`, `/refactor`, `/fix`, `/export`, `/clear`) | Digite `/` no campo |
| Enviar · Nova linha · Interromper · Editar última mensagem | `Enter` · `Shift+Enter` · `Esc` · `↑` (campo vazio) |

---

## Configuração

| Configuração | Padrão | Descrição |
| --- | --- | --- |
| `mangaba.baseUrl` | servidor Mangaba | Endpoint OpenAI-compatível. Já vem apontando para o servidor Mangaba; troque pelo **seu** para soberania total. |
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

O tráfego vai **apenas para o endpoint configurado** (o servidor Mangaba por padrão, ou o seu). Embeddings do RAG e extração de PDF rodam **localmente**. Sem telemetria. Para soberania total (governo, bancos, saúde), aponte `mangaba.baseUrl` para a **sua** infraestrutura — nada sai dela.

## Requisitos

- VS Code **1.85+**. Só isso — a extensão já vem conectada ao servidor Mangaba.
- Opcional: seu próprio servidor **OpenAI-compatível** em `mangaba.baseUrl`; **Ollama** para o RAG na build leve; **Git** para a mensagem de commit.

## FAQ

**Preciso configurar algo para começar?** Não — instale e converse. O seletor de modelos e o status do servidor (barra inferior) já funcionam de fábrica.

**Preciso de internet?** Só entre a extensão e o servidor configurado. Nada vai para nuvens de terceiros.

**Funciona com qualquer modelo?** Sim — qualquer endpoint OpenAI-compatível (Mangaba, vLLM, Ollama, LM Studio, etc.).

**Posso mandar arquivos?** Sim — arraste, cole ou anexe: código, texto, JSON/CSV, logs, **PDF** (texto extraído automaticamente) e **imagens** (visão). Clique no chip para pré-visualizar o que será enviado.

**É seguro rodar o agente?** Sim: todo comando pede **aprovação**, comandos perigosos são bloqueados e cada edição tem **diff + rollback**.

**Por que o modelo às vezes trava em tarefas grandes?** Os modelos menores têm janela de contexto limitada; acompanhe o **contador de tokens** no rodapé e use seleção/`@`-contexto para focar o envio.

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
npm test             # testes unitários (node:test + tsx) das funções puras
npm run typecheck    # checagem de tipos (tsc --noEmit)
npm run package      # gera o .vsix
```

O CI roda `typecheck` + `test` + `build` em todo push/PR (`.github/workflows/ci.yml`) antes de qualquer publicação.

---

<div align="center"><sub><b>Mangaba AI</b> · Feito no Brasil · <a href="https://mangaba.chat">mangaba.chat</a></sub></div>
