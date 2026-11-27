import * as vscode from 'vscode'
import { exec } from 'child_process'
import type { McpTool } from './mcp'
import { parseAction as parseActionPure, safeRelPath } from './pure'

export type ChatFn = (messages: Array<{ role: string; content: string }>) => Promise<string | null>
export type ApplyFileFn = (relPath: string, content: string) => Promise<boolean>
export type McpCallFn = (server: string, name: string, args: unknown) => Promise<string>

interface Action { tool: string; path?: string; content?: string; command?: string; summary?: string; server?: string; name?: string; args?: unknown }

// Comandos destrutivos, escalonamento de privilégio e download-e-executa.
const DANGEROUS = new RegExp([
  'rm\\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)', 'mkfs', 'dd\\s+if=', ':\\(\\)\\s*\\{',
  'shutdown', 'reboot', 'halt\\b', 'poweroff', '>\\s*/dev/sd', 'chmod\\s+-R\\s+777\\s+/',
  'git\\s+push\\s+--force', 'git\\s+reset\\s+--hard\\s+origin',
  '\\bsudo\\b', '\\bdoas\\b', 'launchctl', 'systemctl\\s+(stop|disable|mask)',
  '(curl|wget)[^|;&]*\\|\\s*(ba)?sh', 'base64\\s+(-d|--decode)[^|]*\\|\\s*(ba)?sh',
  'eval\\s+"?\\$\\(', 'history\\s+-c', 'crontab\\s+-r',
  '/etc/(passwd|shadow|sudoers)', '\\.ssh/(id_|authorized_keys)',
  'security\\s+(dump|find-generic|find-internet)', 'defaults\\s+write\\s+com\\.apple',
  'osascript', 'killall\\b', 'diskutil\\s+(erase|partition)',
].join('|'), 'i')

function truncate(s: string, n = 2000): string {
  return s.length > n ? s.slice(0, n) + `\n…(+${s.length - n} chars truncados)` : s
}

function parseAction(text: string): Action | null {
  return parseActionPure(text) as Action | null
}

const SYSTEM =
  'You are an autonomous code agent inside VS Code, working in the user's project folder.\n' +
  'On each turn, reply with EXACTLY ONE action, in a single JSON block, with no text outside it. Tools:\n' +
  '- {"tool":"list"} — lists the project files.\n' +
  '- {"tool":"read","path":"rel/arquivo"} — reads a file.\n' +
  '- {"tool":"write","path":"rel/arquivo","content":"COMPLETE CONTENT"} — creates/overwrites a file (the user reviews it in a diff).\n' +
  '- {"tool":"run","command":"npm test"} — runs a command in the terminal and receives the output (the user approves).\n' +
  '- {"tool":"done","summary":"what was done"} — ends when the task is complete and verified.\n' +
  'Rules: take small steps; read before editing; AFTER editing, RUN the tests/build to verify; if it fails, fix and run again; at the end use "done". Be concise. Write the summary in the user's language (default: English).'

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
    this.out.appendLine(`▶ Task: ${task}\n`)

    // 1) Planejamento — o agente esboça um plano antes de agir.
    const plan = await this.chat([
      { role: 'system', content: 'You are a code agent. Return a short numbered PLAN (3-6 steps) for the task. Just the list, no code.' },
      { role: 'user', content: `Task: ${task}` },
    ])
    if (plan) { this.out.appendLine('📋 Plan:\n' + plan.trim() + '\n') }

    const hint = this.testCommand ? `\nSuggested test command: \`${this.testCommand}\`.` : ''
    const mcpNote = this.mcpTools.length
      ? '\nAvailable MCP tools (use {"tool":"mcp","server":"S","name":"N","args":{...}}):\n' +
        this.mcpTools.map((t) => `- ${t.server}/${t.name}: ${t.description || ''}`).join('\n')
      : ''
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: SYSTEM + hint + mcpNote },
      { role: 'user', content: `Task: ${task}\n\nPlan:\n${(plan || '').trim()}\n\nFollow the plan, one step at a time.` },
    ]

    for (let step = 1; step <= this.maxSteps; step++) {
      const reply = await this.chat(this.trim(messages))
      if (!reply) { this.out.appendLine('✖ Sem resposta do modelo.'); return }
      const action = parseAction(reply)
      if (!action) {
        messages.push({ role: 'assistant', content: reply })
        messages.push({ role: 'user', content: 'Invalid format. Reply with ONE JSON action block (list/read/write/run/done).' })
        continue
      }
      messages.push({ role: 'assistant', content: JSON.stringify(action) })
      this.out.appendLine(`— passo ${step}: ${action.tool} ${action.path || action.command || ''}`)

      if (action.tool === 'done') {
        this.out.appendLine(`\n✔ Done: ${action.summary || ''}`)
        vscode.window.showInformationMessage(`Mangaba (agent): ${action.summary || 'task completed'}`)
        return
      }

      const result = await this.execTool(action)
      this.out.appendLine('  ↳ ' + truncate(result, 400).replace(/\n/g, '\n    '))
      messages.push({ role: 'user', content: `RESULTADO (${action.tool}):\n${truncate(result)}` })
    }
    this.out.appendLine(`\n■ Limite de ${this.maxSteps} passos atingido.`)
    vscode.window.showWarningMessage(`Mangaba (agent): stopped after ${this.maxSteps} steps. See the "Mangaba Agent" channel.`)
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
        const safe = safeRelPath(a.path)
        if (!safe) return `RECUSADO: caminho fora do workspace (${a.path})`
        const buf = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.root, safe))
        return truncate(Buffer.from(buf).toString('utf8'), 6000)
      }
      if (a.tool === 'write' && a.path && typeof a.content === 'string') {
        const safe = safeRelPath(a.path)
        if (!safe) return `RECUSADO: caminho fora do workspace (${a.path})`
        const ok = await this.applyFile(safe, a.content)
        return ok ? `escrito: ${safe}` : `user cancelled the write of ${safe}`
      }
      if (a.tool === 'run' && a.command) {
        return await this.runCommand(a.command)
      }
      if (a.tool === 'mcp' && a.server && a.name && this.mcpCall) {
        return truncate(await this.mcpCall(a.server, a.name, a.args ?? {}), 3000)
      }
      return `ferramenta desconhecida: ${a.tool}`
    } catch (e) {
      return 'ERROR: ' + ((e as Error).message || String(e))
    }
  }

  private async runCommand(command: string): Promise<string> {
    if (DANGEROUS.test(command)) return `RECUSADO (comando perigoso): ${command}`
    if (this.commandApproval !== 'never') {
      const pick = await vscode.window.showWarningMessage(
        `Mangaba (agent) wants to run:\n\n${command}`, { modal: true }, 'Run', 'Skip',
      )
      if (pick !== 'Run') return 'user did not approve the command'
    }
    return new Promise<string>((resolve) => {
      exec(command, { cwd: this.root.fsPath, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code?: number }).code : 0
        resolve(`exit=${code}\n${truncate((stdout || '') + (stderr ? '\n[stderr]\n' + stderr : ''), 3000) || '(no output)'}`)
      })
    })
  }
}
