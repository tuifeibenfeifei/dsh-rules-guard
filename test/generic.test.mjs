// 通用性测试：验证插件在任何 DSH_HOME / profile 下都能正确判定。
//
// 重点不是「在我的机器上能不能拦」，而是「换一台电脑还能不能拦」。
// 所以每个用例都显式传入不同的 env，模拟别人的环境。

import assert from 'node:assert'
import path from 'node:path'
import { parseCommand, unwrap, classifyAction } from '../lib/parse.js'
import { decide, DEFAULT_CONFIG } from '../lib/policy.js'
import { classifyPath, resolveDshHome, resolveProfileDir, isLoadedPluginDir } from '../lib/paths.js'

// ---------- 解析层 ----------

// 包裹命令必须被剥开，否则 sh -c "rm -rf" 会漏
assert.strictEqual(unwrap('sh -c "rm -rf /tmp/x"'), 'rm -rf /tmp/x')
assert.strictEqual(unwrap('cmd /c "del a.txt"'), 'del a.txt')
assert.strictEqual(unwrap('sudo rm -rf /x'), 'rm -rf /x')
assert.strictEqual(unwrap('bash -c \'echo hi\''), 'echo hi')

// 语义分类不依赖命令名穷举
assert.ok(classifyAction('rm -rf x').includes('delete'))
assert.ok(classifyAction('Remove-Item x -Recurse').includes('delete'))
assert.ok(classifyAction('mv a b').includes('move'))
assert.ok(classifyAction('Rename-Item a b').includes('move'))
assert.ok(classifyAction('Stop-Process -Name x').includes('kill'))
assert.ok(classifyAction('explorer .').includes('none'))
assert.ok(classifyAction('echo hi > out.txt').includes('write'))

// 分隔符拆分
const p = parseCommand('echo a && rm -rf b; mv c d')
assert.strictEqual(p.segments.length, 3)
assert.deepStrictEqual(p.segments[1].action.slice(0, 1), ['delete'])

// ---------- 路径推导：换环境 ----------

// Windows 风格
const envWin = { DSH_HOME: 'D:\\other-home', DSH_PROFILE_DIR: 'D:\\other-home\\profiles\\work' }
assert.strictEqual(resolveDshHome(envWin), 'D:\\other-home')
assert.strictEqual(resolveProfileDir(envWin), 'D:\\other-home\\profiles\\work')
assert.ok(classifyPath('D:\\other-home\\storages\\workspace.json', envWin).protected, '别人的 DSH_HOME 也要认')

// POSIX 风格
const envPosix = { DSH_HOME: '/home/alice/.dsh', DSH_PROFILE_DIR: '/home/alice/.dsh/profiles/default' }
assert.strictEqual(resolveDshHome(envPosix), '/home/alice/.dsh')
assert.ok(classifyPath('/home/alice/.dsh/sessions/a.json', envPosix).protected)
assert.ok(classifyPath('/home/alice/.dsh/profiles/default', envPosix).protected)

// 没有环境变量时回退到 ~/.dsh，不能崩
const envEmpty = {}
assert.ok(resolveDshHome(envEmpty).length > 0)
assert.ok(classifyPath(path.join(resolveDshHome(envEmpty), 'storages', 'x.json'), envEmpty).protected)

// 无关路径不该被保护
assert.strictEqual(classifyPath('/tmp/foo.txt', envPosix).protected, false)
assert.strictEqual(classifyPath('C:\\work\\own-project\\readme.md', envWin).protected, false)

// ---------- 策略判定：核心用例 ----------

const T = (toolName, args, config, env = envWin) =>
  decide({ toolName, args }, { ...DEFAULT_CONFIG, ...(config || {}) }, env)

// ① 杀 DSH 自己 —— 各种写法
for (const cmd of [
  'taskkill //IM "DeepSeek Harness.exe" //F',
  'Stop-Process -Name "DeepSeek Harness"',
  'pkill -f deepseek',
  'killall dsh',
  'sh -c "taskkill /IM DeepSeek-Harness.exe /F"',   // 包裹也要识别
]) {
  assert.strictEqual(T('bash', { command: cmd }).decision, 'block', '应拦截：' + cmd)
}

// 杀别的程序不该拦
for (const cmd of ['taskkill /IM notepad.exe /F', 'pkill -f chrome', 'Stop-Process -Name node']) {
  assert.strictEqual(T('bash', { command: cmd }).decision, 'allow', '不该拦：' + cmd)
}

// ② 写 DSH 运行资源
assert.strictEqual(T('write', { path: 'D:\\other-home\\storages\\workspace.json', content: 'x' }).decision, 'block')
assert.strictEqual(T('bash', { command: 'echo x >> D:/other-home/storages/workspace.json' }).decision, 'block')
assert.strictEqual(T('bash', { command: 'cp /tmp/a.json D:/other-home/sidebar-tree.json' }).decision, 'block')

// 读不算写，不该拦
assert.strictEqual(T('read', { path: 'D:\\other-home\\storages\\workspace.json' }).decision, 'allow')

// 写自己项目不该拦
assert.strictEqual(T('write', { path: 'D:\\work\\my-file.js', content: 'x' }).decision, 'allow')
assert.strictEqual(T('bash', { command: 'echo hi > ./notes.txt' }).decision, 'allow')

// ③ 用户白名单优先
assert.strictEqual(
  T('write', { path: 'D:\\other-home\\storages\\workspace.json', content: 'x' }, { allowPaths: ['D:\\other-home\\storages'] }).decision,
  'allow',
  '白名单应放行',
)

// ④ 用户自定义保护路径
assert.strictEqual(
  T('write', { path: 'D:\\secret\\keys.txt', content: 'x' }, { extraProtectedPaths: ['D:\\secret'] }).decision,
  'block',
  '自定义保护路径应生效',
)

// ⑤ 总开关
assert.strictEqual(
  T('bash', { command: 'taskkill //IM "DeepSeek Harness.exe" //F' }, { enabled: false }).decision,
  'allow',
  '关掉后不该拦',
)

// ⑥ 单个拦截器开关
assert.strictEqual(
  T('bash', { command: 'taskkill //IM "DeepSeek Harness.exe" //F' }, { blockSelfKill: false }).decision,
  'allow',
)

// ---------- 中文路径与空格 ----------
assert.strictEqual(
  T('bash', { command: 'echo x >> "D:/other-home/我的数据/workspace.json"' }).decision,
  'block',
  '中文路径也要拦',
)

console.log('all generic tests passed')
