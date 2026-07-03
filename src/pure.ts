// Funções puras (sem dependência do VS Code) — testáveis isoladamente.

/** Remove cercas markdown (```lang ... ```) de uma string de código. */
export function stripFences(s: string): string {
  return s.replace(/^\s*```[a-zA-Z0-9_+#.-]*\n?/, '').replace(/\n?```\s*$/, '').replace(/\s+$/, '')
}

export interface ParsedAction { tool: string; [k: string]: unknown }

/** Extrai a 1ª ação (bloco JSON ou objeto com "tool") de uma resposta do modelo. */
export function parseAction(text: string): ParsedAction | null {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
  const raw = fence ? fence[1] : (text.match(/\{[\s\S]*"tool"[\s\S]*\}/) || [])[0]
  if (!raw) return null
  try {
    const o = JSON.parse(raw)
    return typeof o.tool === 'string' ? (o as ParsedAction) : null
  } catch { return null }
}

/** Divide um texto em chunks com sobreposição (para indexação/embeddings). */
export function chunkText(text: string, size = 900, overlap = 150): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size - overlap) {
    out.push(text.slice(i, i + size))
    if (i + size >= text.length) break
  }
  return out.length ? out : [text]
}

/**
 * Valida um caminho relativo vindo do modelo (agente): precisa ficar DENTRO
 * do workspace. Rejeita absolutos, drive letters, `..` e bytes nulos.
 * Retorna o caminho normalizado (separador /) ou null se inseguro.
 */
export function safeRelPath(rel: string): string | null {
  if (!rel || rel.includes('\0')) return null
  const norm = rel.replace(/\\/g, '/').trim()
  if (norm.startsWith('/') || norm.startsWith('~') || /^[a-zA-Z]:/.test(norm)) return null
  const parts = norm.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) return null
  return parts.length ? parts.join('/') : null
}

// Padrões de segredos comuns (chaves de nuvem, tokens, chaves privadas, senhas em env).
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[CHAVE PRIVADA REDIGIDA]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[AWS_KEY_REDIGIDA]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[GITHUB_TOKEN_REDIGIDO]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[API_KEY_REDIGIDA]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[SLACK_TOKEN_REDIGIDO]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[GOOGLE_KEY_REDIGIDA]'],
  [/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b/g, '[JWT_REDIGIDO]'],
  [/(\b(?:password|passwd|senha|secret|token|api[_-]?key)\s*[=:]\s*["']?)[^\s"']{8,}/gi, '$1[REDIGIDO]'],
  [/(Authorization:\s*(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDIGIDO]'],
  [/((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s]+:)[^@\s]+@/gi, '$1[REDIGIDO]@'],
]

/** Redige segredos conhecidos de um texto antes de enviá-lo ao modelo. */
export function redactSecrets(text: string): { text: string; redacted: number } {
  let out = text
  let count = 0
  for (const [re, sub] of SECRET_PATTERNS) {
    out = out.replace(re, (...args) => {
      count++
      // suporta grupo $1 no replacement (args[1] é o 1º grupo capturado)
      return sub.replace('$1', typeof args[1] === 'string' ? args[1] : '')
    })
  }
  return { text: out, redacted: count }
}

/** true se a URL usa transporte inseguro (http) fora de localhost. */
export function isInsecureUrl(url: string): boolean {
  const m = url.match(/^http:\/\/([^/:]+)/i)
  if (!m) return false
  const host = m[1].toLowerCase()
  return !(host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host.endsWith('.local'))
}

/** Estimativa grosseira de tokens (~4 chars/token, média PT/código). */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0
}

/** Linguagem (para o bloco ```lang) a partir da extensão do arquivo. */
export function langFromExt(ext: string): string {
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
    c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', scala: 'scala',
    sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', sql: 'sql', r: 'r', lua: 'lua',
    json: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', ini: 'ini',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less', vue: 'vue', svelte: 'svelte',
    md: 'markdown', markdown: 'markdown', csv: 'csv', tsv: 'text', log: 'text', txt: 'text',
    env: 'bash', dockerfile: 'dockerfile', makefile: 'makefile', gradle: 'groovy', dart: 'dart',
  }
  return map[ext.toLowerCase()] || 'text'
}

/**
 * Extrai texto legível de um content-stream de PDF já descomprimido.
 * Heurística sem dependências: lê literais `( )` e hex `< >`, insere quebras
 * de linha nos operadores de posicionamento (Td, TD, T-star, aspas) e espaços
 * no kerning grande dentro de arrays TJ. Não resolve fontes/CMaps customizados,
 * então é "best-effort" — cobre a maioria dos PDFs de texto padrão.
 */
export function pdfStreamToText(s: string): string {
  let out = ''
  let line = ''
  let inArray = false
  let i = 0
  const n = s.length
  const flush = () => { if (line.trim()) out += line.replace(/[ \t]+/g, ' ').trim() + '\n'; line = '' }
  const OCT: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }
  while (i < n) {
    const ch = s[i]
    if (ch === '(') {
      let depth = 1; i++
      let str = ''
      while (i < n && depth > 0) {
        const c = s[i]
        if (c === '\\') {
          const nx = s[i + 1]
          if (nx in OCT) { str += OCT[nx]; i += 2; continue }
          if (nx >= '0' && nx <= '7') {
            let oct = nx; i += 2; let k = 0
            while (k < 2 && s[i] >= '0' && s[i] <= '7') { oct += s[i]; i++; k++ }
            str += String.fromCharCode(parseInt(oct, 8) & 0xff); continue
          }
          str += nx ?? ''; i += 2; continue
        }
        if (c === '(') { depth++; str += c; i++; continue }
        if (c === ')') { depth--; if (depth === 0) { i++; break } str += c; i++; continue }
        str += c; i++
      }
      line += str
      continue
    }
    if (ch === '<' && s[i + 1] !== '<') {
      i++; let hex = ''
      while (i < n && s[i] !== '>') { if (/[0-9a-fA-F]/.test(s[i])) hex += s[i]; i++ }
      i++
      if (hex.length % 2) hex += '0'
      for (let k = 0; k < hex.length; k += 2) line += String.fromCharCode(parseInt(hex.substr(k, 2), 16) & 0xff)
      continue
    }
    if (ch === '[') { inArray = true; i++; continue }
    if (ch === ']') { inArray = false; i++; continue }
    if (inArray && (ch === '-' || (ch >= '0' && ch <= '9') || ch === '.')) {
      let j = i; let num = ''
      while (j < n && /[-0-9.]/.test(s[j])) { num += s[j]; j++ }
      const v = parseFloat(num)
      if (!isNaN(v) && v <= -100) line += ' '
      i = j; continue
    }
    if (/[A-Za-z'"*]/.test(ch)) {
      let j = i; let op = ''
      while (j < n && /[A-Za-z0-9*'"]/.test(s[j])) { op += s[j]; j++ }
      if (op === 'Td' || op === 'TD' || op === 'T*' || op === "'" || op === '"' || op === 'ET') flush()
      i = j; continue
    }
    i++
  }
  flush()
  return out.replace(/\n{3,}/g, '\n\n')
}
