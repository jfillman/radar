#!/usr/bin/env node
// Guard: every <ErrorBoundary> must carry `resetKey` (or a `key`).
//
// An error boundary latches. Once getDerivedStateFromError sets hasError,
// nothing clears it except an explicit reset or a remount. Navigating re-renders
// the same boundary instance, so a boundary with neither survives the
// navigation with hasError still set: a view that throws leaves the fallback on
// screen and the user cannot navigate out of it.
//
// Prefer `resetKey={location.pathname}` - it clears the error on navigation
// without remounting healthy children. `key` also works but remounts the
// subtree on every change, discarding child state while nothing is wrong.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = 'src'
const offenders = []

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) walk(p)
    else if (p.endsWith('.tsx')) scan(p)
  }
}

function scan(file) {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(src) === 'ErrorBoundary') {
        const reset = node.attributes.properties.some(
          (attr) => ts.isJsxAttribute(attr) && ['resetKey', 'key'].includes(attr.name.getText(src)),
        )
        if (!reset) {
          const { line } = src.getLineAndCharacterOfPosition(node.getStart(src))
          offenders.push(`${file}:${line + 1}  <ErrorBoundary> with no resetKey`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
}

walk(ROOT)

if (offenders.length) {
  console.error('<ErrorBoundary> with no resetKey found. A caught error survives navigation, trapping the user on the fallback.\n')
  for (const o of offenders) console.error('  ' + o)
  console.error('\nPass resetKey={location.pathname}, or whatever else selects its children.')
  process.exit(1)
}
console.log('✓ every <ErrorBoundary> resets on navigation')
