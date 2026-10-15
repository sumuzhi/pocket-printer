/**
 * On-hardware verification of the complete print path.
 *
 * The command layer (handshake, status, device info) is covered by tests; the
 * FILE TRANSFER is not — it needs real paper. This script is that check, kept in
 * the repo so the verification can be repeated after any protocol change.
 *
 * Usage: node verify-print.mjs <image.jpg>
 * Consumes one sheet of paper.
 */
import { readFileSync } from 'node:fs'
import { BluetoothLink } from './src/bluetooth.ts'
import { PrintSession } from './src/session.ts'
import { frameCountFor } from './src/protocol.ts'

const img = process.argv[2]
if (!img) {
  console.error('用法: node verify-print.mjs <image.jpg>')
  process.exit(2)
}
const file = readFileSync(img)
console.log(`待打印: ${img}`)
console.log(`  ${file.length} 字节 (${(file.length / 1024).toFixed(1)}KB), ${frameCountFor(file.length)} 帧`)
console.log(`  JPEG 头: ${file.subarray(0, 2).toString('hex')} (应为 ffd8)`)

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
