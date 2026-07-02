# Changelog

Todas as mudanças relevantes da extensão **Mangaba AI para VS Code**.

## [0.9.0]
- **RAG @codebase (embeddings locais)** — comando *Indexar projeto*: embeda o código com transformers.js (Xenova/all-MiniLM-L6-v2, 384d) 100% na máquina; o chat recupera os trechos mais similares e injeta como contexto. Config `mangaba.useCodebaseContext`.

## [0.8.0]
- **Histórico de conversas** — salva/lista/retoma conversas (botão no topo do chat).
- **Combo de dev** — Corrigir erros com IA (lâmpada 💡 + comando), Gerar testes, e Gerar mensagem de commit (botão no Source Control).
- **@-contexto** — botão @ no compositor: adiciona arquivo/seleção/erros/arquivo escolhido como contexto (chips).

## [0.6.0]
- **Agente multi-arquivo** — comando *Mangaba AI: Tarefa no projeto (agente)*: descreva uma tarefa e a Mangaba propõe edições em vários arquivos, cada uma revisada em diff antes de aplicar (cria e altera arquivos).

## [0.5.0]
- **Diff de revisão** antes de aplicar código (aceitar/rejeitar), configurável em `mangaba.reviewBeforeApply`.
- **Autocompletar inline (ghost text)** opt-in (`mangaba.inlineCompletions`), com debounce e cancelamento.

## [0.4.0]
- **Editar código pelo chat** — contexto do arquivo/seleção ativos + botões **Aplicar / Inserir / Copiar** nos blocos de código.
- **Editar seleção (IA)** (`Ctrl/Cmd+Alt+K`) — reescreve a seleção conforme a instrução.

## [0.3.x]
- **Visão (multimodal)** — anexar/colar imagem para o `mangaba-vision-q8`.
- Compositor estilo big-tech (ícones SVG, input em pílula).
- README no padrão de marketplace (badges), correções de ícone.

## [0.2.x]
- **Seletor de modelo ao vivo** (busca `/v1/models` do servidor).
- Logo oficial, categorias, atalhos, walkthrough de onboarding.

## [0.1.0]
- Primeira versão: chat com streaming, painel na Activity Bar, explicar seleção.
