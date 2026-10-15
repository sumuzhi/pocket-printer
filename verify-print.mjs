/**
 * On-hardware verification of the complete print path.
 *
 * **THIS CONSUMES A SHEET OF PAPER.** Paper is a consumable, and the print path
 * has already been verified on hardware (jobs 71/72/73 all reached `finished`
 * and produced prints). There is normally no reason to run this again: the
 * protocol layer is covered by 54 offline tests, and the framing was compared
 * byte-for-byte against a known-working implementation.
 *
 * Run it only when a hardware change genuinely needs re-checking, and only with
 * an explicit human decision to spend a sheet.
 *
 * Usage:
 *   node verify-print.mjs <image.jpg> --yes-consume-one-sheet
 *
 * The flag is deliberately long and explicit so it cannot be typed by accident
 * or added reflexively while "just checking that things work".
 */
import { readFileSync } from 'node:fs'
// These three modules are plain TypeScript (no decorators), so Node's type
// stripping runs them directly — the build is only needed for the Nest layer.
import { BluetoothLink } from './src/printer/bluetooth.ts'
import { PrintSession } from './src/printer/session.ts'
import { frameCountFor } from './src/printer/protocol.ts'

const CONFIRM_FLAG = '--yes-consume-one-sheet'
const args = process.argv.slice(2)

if (!args.includes(CONFIRM_FLAG)) {
  const img = args.find((a) => !a.startsWith('--'))
  console.error(`
⛔ 已阻止：本脚本会消耗一张相纸。

相纸是消耗品。打印链路已在真机上验证通过（任务 71/72/73 均出纸），
另有 75 项离线测试，因此通常没有必要再运行这个脚本。

确实需要真机验证时，请显式加上确认参数：

    node verify-print.mjs ${img ?? '<image.jpg>'} ${CONFIRM_FLAG}

不消耗相纸的替代检查：
    npm test                                  # 75 项测试，离线运行
    curl http://127.0.0.1:8000/api/printer/status   # 只读：握手 + 电量 + 固件
`)
  process.exit(2)
}

const img = args.find((a) => !a.startsWith('--'))
if (!img) {
  console.error(`用法: node verify-print.mjs <image.jpg> ${CONFIRM_FLAG}`)
  process.exit(2)
}
const file = readFileSync(img)
console.log(`待打印: ${img}`)
console.log(`  ${file.length} 字节 (${(file.length / 1024).toFixed(1)}KB), ${frameCountFor(file.length)} 帧`)
console.log(`  JPEG 头: ${file.subarray(0, 2).toString('hex')} (应为 ffd8)`)
console.log(`  ⚠ 将消耗 1 张相纸`)

const link = new BluetoothLink({ verbose: false })
const s = new PrintSession(link, false)

try {
  await s.connect()
  console.log(`✅ 握手成功 (MTU ${link.mtu})`)

  const st = await s.status()
  console.log(`打印前: ${st.category} | 电量 ${st.battery}%`)
  if (st.category !== 'idle') {
    console.log(`❌ 打印机非空闲（${st.category}），中止以免浪费相纸`)
    process.exit(1)
  }

  const jobId = await s.createJob(file.length)
  console.log(`✅ print_job 已创建: job_id=${jobId}`)

  const t0 = Date.now()
  await s.sendFile(file, jobId)
  console.log(`✅ 传输完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  console.log('轮询任务状态…')
  const final = await s.waitForJob(jobId, {
    timeoutMs: 180_000,
    intervalMs: 5_000,
    onTick: (j) =>
      console.log(`   [${j.state}] 传输 ${j.transferTime ?? '-'}ms 打印 ${j.printTime ?? '-'}ms`),
  })

  console.log()
  if (final.state === 'finished') {
    console.log(`🎉 打印完成: job=${jobId}  出纸 ${final.copies} 张  打印耗时 ${final.printTime}ms`)
    process.exit(0)
  }
  console.log(`⚠ 未确认完成: ${final.state}`)
  process.exit(2)
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  console.log('❌ 失败:', msg)
  if (msg.includes('无法打开打印通道')) {
    console.log('')
    console.log('提示：若有送印服务正在运行，请先停掉它——RFCOMM 通道独占，')
    console.log('      服务与这个脚本不能同时连接打印机。')
  }
  process.exit(1)
} finally {
  await s.close()
}
