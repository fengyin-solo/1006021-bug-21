// Node 下直跑 TS 验证脚本的极简 require 钩子（无第三方依赖，绕开损坏的 esbuild/rollup 原生包）。
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const cache = new Map()

function compile(file) {
  if (cache.has(file)) return cache.get(file)
  const source = fs.readFileSync(file, 'utf8')
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: file,
  })
  cache.set(file, out.outputText)
  return out.outputText
}

require.extensions['.ts'] = function (module, filename) {
  module._compile(compile(filename), filename)
}

const originalResolve = require('module')._resolveFilename
require('module')._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@/')) {
    request = path.join(root, 'src', request.slice(2))
  }
  let resolved
  for (const ext of ['.ts', '.js']) {
    const candidate = request.endsWith(ext) ? request : request + ext
    if (fs.existsSync(candidate)) {
      resolved = candidate
      break
    }
  }
  if (!resolved && fs.existsSync(path.join(request, 'index.ts'))) {
    resolved = path.join(request, 'index.ts')
  }
  arguments[0] = resolved || request
  return originalResolve.apply(this, arguments)
}

module.exports = { compile }
