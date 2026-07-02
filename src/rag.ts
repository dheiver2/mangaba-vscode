import * as vscode from 'vscode'

// RAG @codebase — embeddings 100% locais via transformers.js (Xenova/all-MiniLM-L6-v2).
// Nenhum dado sai da máquina; o modelo (~25MB) é baixado uma vez e fica em cache.

let extractorPromise: Promise<(t: string, o: object) => Promise<{ data: Float32Array }>> | null = null
async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const mod = await import('@xenova/transformers')
      ;(mod.env as { allowLocalModels?: boolean }).allowLocalModels = false
      return mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2') as unknown as (t: string, o: object) => Promise<{ data: Float32Array }>
    })()
  }
  return extractorPromise
}

async function embedLocal(text: string): Promise<number[]> {
  const ex = await getExtractor()
  const r = await ex(text, { pooling: 'mean', normalize: true })
  return Array.from(r.data)
}

// Backend alternativo: Ollama local (zero binário nativo → vsix leve/portátil).
async function embedOllama(text: string, url: string, model: string): Promise<number[]> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  })
  if (!res.ok) throw new Error(`Ollama embeddings HTTP ${res.status} (rode: ollama pull ${model})`)
  const d = (await res.json()) as { embedding?: number[]; embeddings?: number[][] }
  const v = d.embedding ?? d.embeddings?.[0]
  if (!v) throw new Error('Ollama: resposta sem embedding')
  return v
}

async function embedOne(text: string): Promise<number[]> {
  const c = vscode.workspace.getConfiguration('mangaba')
  if ((c.get<string>('embeddingsBackend') || 'transformers') === 'ollama') {
    return embedOllama(
      text,
      c.get<string>('ollamaEmbedUrl') || 'http://localhost:11434/api/embeddings',
      c.get<string>('ollamaEmbedModel') || 'nomic-embed-text',
    )
  }
  return embedLocal(text)
}

function dot(a: number[], b: number[]): number {
  let d = 0
  for (let i = 0; i < a.length; i++) d += a[i] * b[i]
  return d
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|go|rb|rs|c|cc|cpp|h|hpp|cs|php|kt|swift|scala|sh|sql|json|ya?ml|md|html|css|scss|less|vue|svelte|astro)$/i

function chunk(text: string, size = 900, overlap = 150): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size - overlap) {
    out.push(text.slice(i, i + size))
    if (i + size >= text.length) break
  }
  return out.length ? out : [text]
}

interface Item { file: string; text: string; vec: number[] }

export class CodeIndex {
  private items: Item[] = []
  private loaded = false
  constructor(private ctx: vscode.ExtensionContext) {}

  private dir() { return this.ctx.storageUri ?? this.ctx.globalStorageUri }
  private file() { return vscode.Uri.joinPath(this.dir(), 'mangaba-index.json') }

  async load() {
    if (this.loaded) return
    try {
      const buf = await vscode.workspace.fs.readFile(this.file())
      this.items = (JSON.parse(Buffer.from(buf).toString('utf8')).items) || []
    } catch { this.items = [] }
    this.loaded = true
  }

  size() { return this.items.length }

  async save() {
    try { await vscode.workspace.fs.createDirectory(this.dir()) } catch { /* já existe */ }
    await vscode.workspace.fs.writeFile(this.file(), Buffer.from(JSON.stringify({ model: 'all-MiniLM-L6-v2', items: this.items })))
  }

  /** Indexa o workspace: varre arquivos de código, chunka e embeda tudo localmente. */
  async build(progress: vscode.Progress<{ message?: string }>): Promise<{ files: number; chunks: number; truncated: boolean }> {
    const uris = (await vscode.workspace.findFiles('**/*', '**/{node_modules,dist,out,build,.git,.next,coverage,.venv,__pycache__}/**', 1000))
      .filter((u) => CODE_EXT.test(u.path))
    const chunks: Array<{ file: string; text: string }> = []
    for (const u of uris) {
      try {
        const buf = await vscode.workspace.fs.readFile(u)
        if (buf.length > 200000) continue
        const text = Buffer.from(buf).toString('utf8')
        const rel = vscode.workspace.asRelativePath(u)
        for (const c of chunk(text)) if (c.trim()) chunks.push({ file: rel, text: c })
      } catch { /* ignora binário/ilegível */ }
    }
    const MAX = 2500
    const slice = chunks.slice(0, MAX)
    this.items = []
    for (let i = 0; i < slice.length; i++) {
      const vec = await embedOne(slice[i].text)
      this.items.push({ file: slice[i].file, text: slice[i].text, vec })
      if (i % 20 === 0) progress.report({ message: `Embeddings ${i + 1}/${slice.length}` })
    }
    this.loaded = true
    await this.save()
    return { files: uris.length, chunks: this.items.length, truncated: chunks.length > MAX }
  }

  /** Recupera os K trechos mais similares à consulta. */
  async search(query: string, k = 5): Promise<Item[]> {
    await this.load()
    if (!this.items.length || !query.trim()) return []
    const q = await embedOne(query)
    return this.items
      .map((it) => ({ it, s: dot(q, it.vec) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.it)
  }
}
