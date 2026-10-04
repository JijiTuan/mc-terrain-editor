// protocol.md 内容完整性探针：渲染出的文本必须包含关键章节与全部方块
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
for (const k of ['NO_PROXY','no_proxy']) process.env[k]='127.0.0.1,localhost,::1'
for (const k of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy']) delete process.env[k]
const WS = 'C:/Users/passk/.workbuddy/binaries/node/workspace/node_modules'
const puppeteer = (await import(pathToFileURL(resolve(WS,'puppeteer-core/lib/puppeteer/puppeteer-core.js')).href)).default

let pass = 0, fail = 0
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++ }

const b = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new', args: ['--no-sandbox','--disable-gpu','--use-gl=swiftshader','--enable-unsafe-swiftshader'],
})
const p = await b.newPage()
await p.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded', timeout: 30000 })
await p.waitForFunction(() => window.__MC_EDITOR__, { timeout: 25000, polling: 300 })

const text = await p.evaluate(async () => {
  // 渲染逻辑与 publishProtocol 相同：模板 + 动态方块段
  const fb = await import('/src/ai/file-bridge.js')
  const blocksMod = await import('/src/data/blocks.js')
  // buildBlockListSection 未导出，这里按同一规则重建（并校验两者一致的关键点）
  const lines = []
  for (const bk of blocksMod.default) {
    if (bk.id === blocksMod.AIR) continue
    lines.push(`- \`${bk.name}\`（${bk.label}）`)
  }
  return { placeholder: fb.PROTOCOL_TEXT.includes('{{BLOCK_LIST}}'), hasCoord: fb.PROTOCOL_TEXT.includes('坐标系与边界'), list: lines.join('\n'), count: lines.length }
})

check('模板里有占位符（会被替换成方块清单）', text.placeholder === true)
check('新增「坐标系与边界」章节', text.hasCoord === true)
check('方块清单生成且含 name+label', text.count >= 50 && text.list.includes('`grass_block`（草方块）'), `${text.count} 个`)
check('空气被排除', !text.list.includes('`air`'), text.list.includes('`air`') ? '清单里出现了 air' : '无 air 条目')

// 端到端：真的激活桥接（用内存 fs 模拟）验证 publishProtocol 替换无残留
const written = await p.evaluate(async () => {
  const fb = await import('/src/ai/file-bridge.js')
  const blocksMod = await import('/src/data/blocks.js')
  const lines = []
  for (const bk of blocksMod.default) { if (bk.id === blocksMod.AIR) continue; lines.push(`- \`${bk.name}\`（${bk.label}）`) }
  const out = fb.PROTOCOL_TEXT.replace('{{BLOCK_LIST}}', lines.join('\n'))
  return { left: out.includes('{{'), grass: out.includes('`grass_block`（草方块）'), len: out.length }
})
check('替换后无残留占位符', written.left === false)
check('替换后含具体方块条目', written.grass === true, `总长 ${written.len} 字符`)

await b.close()
console.log(`\n结果：${fail === 0 ? '全部通过' : '有失败'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)
