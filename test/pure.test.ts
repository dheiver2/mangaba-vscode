import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripFences, parseAction, chunkText, langFromExt, pdfStreamToText } from '../src/pure'

test('stripFences: remove cerca com linguagem', () => {
  assert.equal(stripFences('```ts\nconst x = 1\n```'), 'const x = 1')
})

test('stripFences: remove cerca sem linguagem', () => {
  assert.equal(stripFences('```\nhello\n```'), 'hello')
})

test('stripFences: texto sem cerca fica intacto (trim à direita)', () => {
  assert.equal(stripFences('sem cerca aqui  '), 'sem cerca aqui')
})

test('stripFences: cerca com dígitos/símbolos na linguagem (c++, c#)', () => {
  assert.equal(stripFences('```c++\nint a;\n```'), 'int a;')
})

test('parseAction: bloco json cercado', () => {
  const a = parseAction('Vou listar:\n```json\n{"tool":"list"}\n```')
  assert.deepEqual(a, { tool: 'list' })
})

test('parseAction: objeto sem cerca com campos extras', () => {
  const a = parseAction('{"tool":"write","path":"a.ts","content":"x"}')
  assert.equal(a?.tool, 'write')
  assert.equal(a?.path, 'a.ts')
})

test('parseAction: sem tool retorna null', () => {
  assert.equal(parseAction('{"foo":"bar"}'), null)
})

test('parseAction: json inválido retorna null', () => {
  assert.equal(parseAction('```json\n{tool: list}\n```'), null)
})

test('parseAction: texto puro retorna null', () => {
  assert.equal(parseAction('só uma frase, sem json'), null)
})

test('chunkText: texto curto vira 1 chunk', () => {
  assert.deepEqual(chunkText('abc', 900, 150), ['abc'])
})

test('chunkText: respeita tamanho e sobreposição', () => {
  const chunks = chunkText('a'.repeat(2000), 900, 150)
  assert.ok(chunks.length >= 2)
  assert.ok(chunks.every((c) => c.length <= 900))
  // cobre o texto inteiro (sem buracos, graças ao overlap)
  assert.ok(chunks.join('').length >= 2000)
})

test('chunkText: string vazia não trava (retorna [""])', () => {
  assert.deepEqual(chunkText('', 900, 150), [''])
})

test('langFromExt: mapeia extensões comuns', () => {
  assert.equal(langFromExt('ts'), 'typescript')
  assert.equal(langFromExt('PY'), 'python')
  assert.equal(langFromExt('yml'), 'yaml')
})

test('langFromExt: desconhecida vira text', () => {
  assert.equal(langFromExt('xyz'), 'text')
})

test('pdfStreamToText: literal simples com Tj', () => {
  const stream = 'BT /F1 12 Tf (Ola mundo) Tj ET'
  assert.equal(pdfStreamToText(stream).trim(), 'Ola mundo')
})

test('pdfStreamToText: quebra de linha em T*', () => {
  const stream = 'BT (linha um) Tj T* (linha dois) Tj ET'
  assert.deepEqual(pdfStreamToText(stream).trim().split('\n'), ['linha um', 'linha dois'])
})

test('pdfStreamToText: array TJ com kerning vira espaço', () => {
  const stream = 'BT [(Ola)-200(mundo)] TJ ET'
  assert.equal(pdfStreamToText(stream).trim(), 'Ola mundo')
})

test('pdfStreamToText: hex string', () => {
  // "Hi" = 0x48 0x69
  const stream = 'BT <4869> Tj ET'
  assert.equal(pdfStreamToText(stream).trim(), 'Hi')
})

test('pdfStreamToText: escape octal e parênteses', () => {
  const stream = 'BT (A\\050B\\051) Tj ET'
  assert.equal(pdfStreamToText(stream).trim(), 'A(B)')
})
