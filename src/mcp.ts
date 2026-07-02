import { spawn, ChildProcess } from 'child_process'
import * as vscode from 'vscode'

// Cliente MCP mínimo (JSON-RPC 2.0 sobre stdio, framing estilo LSP).
// Configure servidores em mangaba.mcpServers: [{ name, command, args }].

export interface McpTool { server: string; name: string; description?: string }

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void }

class McpServer {
  private proc?: ChildProcess
  private buf = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  tools: McpTool[] = []

  constructor(public readonly name: string, private command: string, private args: string[], private cwd?: string) {}

  async start(): Promise<void> {
    this.proc = spawn(this.command, this.args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout?.on('data', (d: Buffer) => this.onData(d))
    this.proc.stderr?.on('data', () => { /* logs do servidor */ })
    this.proc.on('error', () => { /* servidor indisponível */ })
    await this.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mangaba-vscode', version: '0.11.0' },
    })
    this.notify('notifications/initialized', {})
    const res = (await this.request('tools/list', {})) as { tools?: Array<{ name: string; description?: string }> }
    this.tools = (res?.tools ?? []).map((t) => ({ server: this.name, name: t.name, description: t.description }))
  }

  // MCP stdio: JSON-RPC delimitado por newline (NDJSON), sem headers.
  private send(obj: unknown) {
    this.proc?.stdin?.write(JSON.stringify(obj) + '\n')
  }
  private notify(method: string, params: unknown) { this.send({ jsonrpc: '2.0', method, params }) }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('MCP timeout')) } }, 30000)
    })
  }

  private onData(d: Buffer) {
    this.buf += d.toString()
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } }
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          msg.error ? p.reject(new Error(msg.error.message || 'MCP erro')) : p.resolve(msg.result)
        }
      } catch { /* linha parcial/ruído */ }
    }
  }

  async call(name: string, args: unknown): Promise<string> {
    const r = (await this.request('tools/call', { name, arguments: args })) as { content?: Array<{ type: string; text?: string }> }
    return (r?.content ?? []).map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n') || '(sem saída)'
  }
  stop() { this.proc?.kill() }
}

export class McpManager {
  private servers: McpServer[] = []
  private started = false

  async init(): Promise<void> {
    if (this.started) return
    this.started = true
    const cfg = vscode.workspace.getConfiguration('mangaba').get<Array<{ name: string; command: string; args?: string[] }>>('mcpServers') || []
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    for (const s of cfg) {
      if (!s?.name || !s?.command) continue
      const srv = new McpServer(s.name, s.command, s.args ?? [], cwd)
      try { await srv.start(); this.servers.push(srv) } catch { /* ignora servidor que falhou */ }
    }
  }
  tools(): McpTool[] { return this.servers.flatMap((s) => s.tools) }
  async call(server: string, name: string, args: unknown): Promise<string> {
    const s = this.servers.find((x) => x.name === server)
    if (!s) throw new Error('MCP server não encontrado: ' + server)
    return s.call(name, args)
  }
  dispose() { this.servers.forEach((s) => s.stop()); this.servers = []; this.started = false }
}
