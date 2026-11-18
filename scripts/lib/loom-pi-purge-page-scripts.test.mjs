// Parse every page expression used by the live Pi fixture without opening a
// browser, starting a Host, loading credentials, or sending a model request.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pageScript } from './loom-owned-page.mjs'
import { UI, rosterJs, tagMemberJs, tagByTextJs, tagChoiceItemJs } from './loom-browser-live-mode.mjs'
const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')

test('every generated Pi UI page expression compiles with the actual browser wrapper', async t => {
  const source = await readFile(new URL('./loom-pi-purge-production-ui.test.mjs', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('pi-ui.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  assert.equal(ast.parseDiagnostics.length, 0)
  const context = { UI, rosterJs, tagMemberJs, tagByTextJs, tagChoiceItemJs,
    selector: '.ln-studio-tabs button', text: '运行与权限', tag: 'fixture-tag',
    trigger: 'button[aria-label="Pi Purge 模式"]', actual: '读写文件并处理任务',
    target: { displayName: '助手 "A"\n验收' }, row: { name: '助手 "A"\n验收' },
    goal: '目标含 "双引号"、\'单引号\'与\n换行',
    rowSelector: '.ln-run-panel[data-mission-id="mission-1"] .ln-run-artifact[data-artifact-id="artifact-2"] button.ln-run-file',
    marker: 'LOOM_PERSONA_fixture', nonce: 'LOOM_TASK_fixture'
  }
  // Keep top-level selectors from the fixture itself, so their edits are covered.
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !['STUDIO','PERSONA_INPUT','PURGE_TRIGGER','FILE_TRIGGER'].includes(declaration.name.text)) continue
      context[declaration.name.text] = new Function(...Object.keys(context), 'return (' + declaration.initializer.getText(ast) + ')')(...Object.values(context))
    }
  }
  const lines = [], forwarded = []
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['evalValue','waitPage'].includes(node.expression.text)) {
      const argument = node.arguments[0]
      assert.ok(argument)
      const position = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
      if (ts.isIdentifier(argument) && argument.text === 'expression') forwarded.push(position)
      else {
        const code = new Function(...Object.keys(context), 'return (' + argument.getText(ast) + ')')(...Object.values(context))
        assert.equal(typeof code, 'string', 'non-string page script at line ' + position)
        assert.doesNotThrow(() => new Function(pageScript(code)), 'invalid page script at line ' + position)
        lines.push(position)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(forwarded.length, 1, 'only waitPage may forward its already checked expression')
  assert.ok(lines.length > 0, 'the fixture must contain page expressions')
  t.diagnostic(lines.length + ' page expressions compiled; one waitPage forwarding call covered by those expressions')
})
