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
