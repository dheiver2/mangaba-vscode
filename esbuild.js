const esbuild = require('esbuild')

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  external: ['vscode', '@xenova/transformers', 'onnxruntime-node', 'sharp'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
}

async function main() {
  // Worker do pdfjs empacotado à parte — carregado em runtime via
  // GlobalWorkerOptions.workerSrc = <dist>/pdf.worker.mjs (extração de PDF).
  await esbuild.build({
    ...shared,
    entryPoints: ['pdfjs-dist/legacy/build/pdf.worker.mjs'],
    format: 'esm',
    outfile: 'dist/pdf.worker.mjs',
  })

  const ctx = await esbuild.context({
    ...shared,
    entryPoints: ['src/extension.ts'],
    format: 'cjs',
    outfile: 'dist/extension.js',
  })
  if (watch) {
    await ctx.watch()
  } else {
    await ctx.rebuild()
    await ctx.dispose()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
