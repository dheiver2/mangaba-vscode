import * as vscode from 'vscode'
import { exec } from 'child_process'
import type { McpTool } from './mcp'
import { parseAction as parseActionPure } from './pure'

export type ChatFn = (messages: Array<{ role: string; content: string }>) => Promise<string | null>
export type ApplyFileFn = (relPath: string, content: string) => Promise<boolean>
export type McpCallFn = (server: string, name: string, args: unknown) => Promise<string>

interface Action { tool: string; path?: string; content?: string; command?: string; summary?: string; server?: string; name?: string; args?: unknown }

const DANGEROUS = /\b(rm\s+-rf|mkfs|dd\s+if=|:\(\)\s*\{|shutdown|reboot|>\s*\/dev\/sd|chmod\s+-R\s+777\s+\/|git\s+push\s+--force)/i

function truncate(s: string, n = 2000): string {
  return s.length > n ? s.slice(0, n) + `\n…(+${s.length - n} chars truncados)` : s
}

function parseAction(text: string): Action | null {
  return parseActionPure(text) as Action | null
}

const SYSTEM =
  'Você é um agente de código autônomo dentro do VS Code, trabalhando na pasta do projeto do usuário.\n' +
  'A cada turno, responda com EXATAMENTE UMA ação, num único bloco JSON, sem texto fora dele. Ferramentas:\n' +
  '- {"tool":"list"} — lista os arquivos do projeto.\n' +
  '- {"tool":"read","path":"rel/arquivo"} — lê um arquivo.\n' +
  '- {"tool":"write","path":"rel/arquivo","content":"CONTEÚDO COMPLETO"} — cria/sobrescreve um arquivo (o usuário revisa em diff).\n' +
  '- {"tool":"run","command":"npm test"} — roda um comando no terminal e recebe a saída (o usuário aprova).\n' +
  '- {"tool":"done","summary":"o que foi feito"} — encerra quando a tarefa estiver concluída e verificada.\n' +
  'Regras: dê passos pequenos; leia antes de editar; DEPOIS de editar, RODE os testes/build para verificar; se falhar, corrija e rode de novo; ao final use "done". Seja conciso.'

export class AgentRunner {
  private out: vscode.OutputChannel
  constructor(
    private chat: ChatFn,
    private applyFile: ApplyFileFn,
    private root: vscode.Uri,
    private testCommand: string,
    private commandApproval: string,   // 'always' | 'never'
    private maxSteps: number,
    private mcpTools: McpTool[] = [],
    private mcpCall?: McpCallFn,
  ) {
    this.out = vscode.window.createOutputChannel('Mangaba Agente')
  }

  async run(task: string) {
    this.out.show(true)
    this.out.appendLine(`▶ Tarefa: ${task}\n`)

    // 1) Planejamento — o agente esboça um plano antes de agir.
    const plan = await this.chat([
      { role: 'system', content: 'Você é um agente de código. Devolva um PLANO curto e numerado (3-6 passos) para a tarefa. Só a lista, sem código.' },
      { role: 'user', content: `Tarefa: ${task}` },
    ])
    if (plan) { this.out.appendLine('📋 Plano:\n' + plan.trim() + '\n') }

    const hint = this.testCommand ? `\nComando de teste sugerido: \`${this.testCommand}\`.` : ''
    const mcpNote = this.mcpTools.length
      ? '\nFerramentas MCP disponíveis (use {"tool":"mcp","server":"S","name":"N","args":{...}}):\n' +
        this.mcpTools.map((t) => `- ${t.server}/${t.name}: ${t.description || ''}`).join('\n')
      : ''
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: SYSTEM + hint + mcpNote },
      { role: 'user', content: `Tarefa: ${task}\n\nPlano:\n${(plan || '').trim()}\n\nSiga o plano, um passo por vez.` },
    ]

    for (let step = 1; step <= this.maxSteps; step++) {
      const reply = await this.chat(this.trim(messages))
      if (!reply) { this.out.appendLine('✖ Sem resposta do modelo.'); return }
      const action = parseAction(reply)
      if (!action) {
        messages.push({ role: 'assistant', content: reply })
        messages.push({ role: 'user', content: 'Formato inválido. Responda com UM bloco JSON de ação (list/read/write/run/done).' })
        continue
      }
      messages.push({ role: 'assistant', content: JSON.stringify(action) })
      this.out.appendLine(`— passo ${step}: ${action.tool} ${action.path || action.command || ''}`)

      if (action.tool === 'done') {
        this.out.appendLine(`\n✔ Concluído: ${action.summary || ''}`)
        vscode.window.showInformationMessage(`Mangaba (agente): ${action.summary || 'tarefa concluída'}`)
        return
      }

      const result = await this.execTool(action)
      this.out.appendLine('  ↳ ' + truncate(result, 400).replace(/\n/g, '\n    '))
      messages.push({ role: 'user', content: `RESULTADO (${action.tool}):\n${truncate(result)}` })
    }
    this.out.appendLine(`\n■ Limite de ${this.maxSteps} passos atingido.`)
    vscode.window.showWarningMessage(`Mangaba (agente): parou em ${this.maxSteps} passos. Veja o canal "Mangaba Agente".`)
  }

  /** Mantém system + as últimas mensagens para caber na janela do modelo. */
  private trim(messages: Array<{ role: string; content: string }>) {
    if (messages.length <= 9) return messages
    return [messages[0], ...messages.slice(-8)]
  }

  private async execTool(a: Action): Promise<string> {
    try {
      if (a.tool === 'list') {
        const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,dist,out,build,.git,.venv}/**', 300)
        return uris.map((u) => vscode.workspace.asRelativePath(u)).join('\n') || '(vazio)'
      }
      if (a.tool === 'read' && a.path) {
        const buf = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.root, a.path))
        return truncate(Buffer.from(buf).toString('utf8'), 6000)
      }
      if (a.tool === 'write' && a.path && typeof a.content === 'string') {
        const ok = await this.applyFile(a.path, a.content)
        return ok ? `escrito: ${a.path}` : `usuário cancelou a escrita de ${a.path}`
      }
      if (a.tool === 'run' && a.command) {
        return await this.runCommand(a.command)
      }
      if (a.tool === 'mcp' && a.server && a.name && this.mcpCall) {
        return truncate(await this.mcpCall(a.server, a.name, a.args ?? {}), 3000)
      }
      return `ferramenta desconhecida: ${a.tool}`
    } catch (e) {
      return 'ERRO: ' + ((e as Error).message || String(e))
    }
  }

  private async runCommand(command: string): Promise<string> {
    if (DANGEROUS.test(command)) return `RECUSADO (comando perigoso): ${command}`
    if (this.commandApproval !== 'never') {
      const pick = await vscode.window.showWarningMessage(
        `Mangaba (agente) quer rodar:\n\n${command}`, { modal: true }, 'Rodar', 'Pular',
      )
      if (pick !== 'Rodar') return 'usuário não aprovou o comando'
    }
    return new Promise<string>((resolve) => {
      exec(command, { cwd: this.root.fsPath, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code?: number }).code : 0
        resolve(`exit=${code}\n${truncate((stdout || '') + (stderr ? '\n[stderr]\n' + stderr : ''), 3000) || '(sem saída)'}`)
      })
    })
  }
}
