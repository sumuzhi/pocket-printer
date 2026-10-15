# 使用指南

本文档说明如何安装、使用与排查 **pocket-printer**。

- 只想快速跑起来 → 看[快速开始](#快速开始)
- 想接入自己的程序 → 看[接口参考](#接口参考)
- 遇到问题 → 看[故障排查](#故障排查)

---

## 目录

- [它能做什么](#它能做什么)
- [环境准备](#环境准备)
- [安装](#安装)
- [快速开始](#快速开始)
- [准备成片](#准备成片)
- [接口参考](#接口参考)
- [命令行参数](#命令行参数)
- [自动发现打印机](#自动发现打印机)
- [打印一张的完整流程](#打印一张的完整流程)
- [故障排查](#故障排查)
- [不消耗相纸的检查方式](#不消耗相纸的检查方式)
- [作为库使用](#作为库使用)

---

## 它能做什么

把**已经渲染好**的图片通过蓝牙送到米家口袋打印机 Pro。

```
你的程序                    本服务                 打印机
   │                          │                     │
   │  渲染成 1200×1800 JPEG   │                     │
   ├──── POST /api/staged ────►│  暂存字节            │
   │                          │                     │
   ├──── POST /api/print ────►│  蓝牙 SPP ─────────►│  出纸
   │                          │                     │
```

**它不做的事**：不裁剪、不旋转、不缩放、不加滤镜、不压缩。图像处理由调用方完成
（见 [ADR-0003](adr/0003-server-owns-no-image-processing.md)）。

这样划分的原因：如果服务端也改图，"你看到的"与"实际打印的"就可能不一致——
而这个项目的前身正是在这里踩过坑（预览与实际不符，浪费相纸）。

---

## 环境准备

| 要求 | 检查方式 | 说明 |
|---|---|---|
| macOS | `uname` | 蓝牙经典串口只有 macOS 的 IOBluetooth 能访问 |
| Node.js ≥ 22 | `node -v` | 运行构建产物 |
| Xcode 命令行工具 | `xcode-select -p` | 编译原生蓝牙模块 |
| 已配对的打印机 | 见下 | 只需配对一次 |

### 配对打印机

1. 打开打印机（长按电源键）
2. 打开「系统设置 → 蓝牙」
3. 等待「米家口袋打印机Pro-XXXX」出现，点「连接」

配对后系统会记住它，之后无需重复。

若未装 Xcode 命令行工具：

```bash
xcode-select --install
```

---

## 安装

```bash
git clone <仓库地址> pocket-printer
cd pocket-printer
npm install
```

`npm install` 会**自动编译原生蓝牙模块**（约 10 秒）。编译需要 Xcode 命令行工具。

若编译失败，可单独重试：

```bash
npm run build:native
```

### 命令

遵循 NestJS 官方模板约定：

| 命令 | 用途 |
|---|---|
| **`npm run start:dev`** | **开发模式：监听改动并自动重启** |
| `npm run build` | 生产构建（`nest build`） |
| `npm start` | 运行（`nest start`，会先编译） |
| `npm run start:debug` | 同上并开启调试器 |
| `npm run start:prod` | 运行构建产物（`node dist/main`） |
| `npm test` | 58 项测试，不需要打印机 |

**为什么需要编译**：NestJS 通过 `design:paramtypes` 元数据解析依赖注入，
而该元数据需要 TypeScript 编译器生成——Node 的类型擦除与 esbuild 都会丢弃它。
因此即便开发模式也经过编译（`nest start --watch` 内部即 `tsc -w` + 重启），
只是这个过程由框架管理，无需手动执行。

---

## 快速开始

```bash
npm run start:dev
```

启动后输出：

```
口袋打印机 · 送印服务（Node v24.16.0）
  地址: http://127.0.0.1:8000
  蓝牙: 自动发现（3 台候选设备）
        f0-13-c1-xx-xx-xx  米家口袋打印机Pro-A2BF
        c0-da-5e-65-21-f2  HUAWEI FreeClip 2
        80-a9-97-61-6e-a4  地里拣的iPad Pro
  职责: 接收成片字节并送印，不做任何图像处理
```

第一行蓝牙列表就是**自动发现**的结果——打印机排在第一位（按名称匹配打分）。
无需任何配置。

然后验证打印机可达（**只读，不耗纸**）：

```bash
curl http://127.0.0.1:8000/api/printer/status
```

```json
{
  "available": true,
  "reachable": true,
  "handshake_ok": true,
  "device": "f0-13-c1-xx-xx-xx",
  "battery": 83,
  "category": "idle",
  "fw": "2.1.2_0041",
  "sn": "66497/...",
  "model": "xiaomi.printer.ricott"
}
```

看到 `reachable: true` 就说明一切就绪。

---

## 准备成片

打印机对成片有硬性要求：

| 项 | 值 |
|---|---|
| 尺寸 | **1200 × 1800**（2:3 竖版） |
| 格式 | JPEG |
| 大小 | ≤ **2048 KB** |

### 用 ImageMagick

```bash
# 铺满裁切（填满画面，超出部分裁掉）
magick input.png -resize 1200x1800^ -gravity center -extent 1200x1800 \
       -quality 92 sheet.jpg

# 完整留白（整图可见，空白处为白）
magick input.png -resize 1200x1800 -background white -gravity center \
       -extent 1200x1800 -quality 92 sheet.jpg
```

### 用 Python (Pillow)

```python
from PIL import Image

im = Image.open("input.png").convert("RGB")

# 完整留白：整图缩放后居中贴到白底上
im.thumbnail((1200, 1800), Image.LANCZOS)
canvas = Image.new("RGB", (1200, 1800), (255, 255, 255))
canvas.paste(im, ((1200 - im.width) // 2, (1800 - im.height) // 2))
canvas.save("sheet.jpg", quality=92)
```

### 用 Node (sharp)

```js
import sharp from 'sharp'

await sharp('input.png')
  .resize(1200, 1800, { fit: 'cover', position: 'centre' }) // 铺满裁切
  .jpeg({ quality: 92 })
  .toFile('sheet.jpg')
```

> **质量建议**：1200×1800 的 JPEG 在质量 90 左右通常只有 200–500KB，远低于上限。
> 不必为了控制大小而牺牲画质。

---

## 接口参考

基地址：`http://127.0.0.1:8000`

### `GET /api/health`

服务信息与约束。

```json
{
  "ok": true,
  "version": "1.0.0",
  "runtime": "node v24.16.0",
  "role": "print-only",
  "job": { "width": 1200, "height": 1800 },
  "maxImageKb": 2048
}
```

### `GET /api/device`

蓝牙可用性与发现的候选设备。

```json
{
  "mac": {
    "available": true,
    "configured": false,
    "candidates": [
      { "address": "f0-13-c1-xx-xx-xx", "name": "米家口袋打印机Pro-A2BF" }
    ]
  },
  "phone": { "online": false },
  "busy": null
}
```

- `available` — 原生模块是否已编译
- `configured` — 是否用 `--address` 指定了地址
- `candidates` — 系统已知的蓝牙设备（未连接，仅枚举）
- `busy` — 非 null 表示正在执行另一个打印任务

### `GET /api/printer/status`

**只读探测，不消耗相纸。** 会实际连接并握手。

成功：

```json
{
  "available": true, "reachable": true, "handshake_ok": true,
  "device": "f0-13-c1-xx-xx-xx",
  "battery": 83, "category": "idle",
  "fw": "2.1.2_0041", "sn": "66497/...", "model": "xiaomi.printer.ricott"
}
```

失败（HTTP 仍是 200，便于前端展示）：

```json
{
  "available": true, "reachable": false, "handshake_ok": false,
  "message": "打印机不可达：请确认已开机（休眠后需要按一下按钮唤醒）。"
}
```

> **注意**：这个请求会阻塞数秒（连接 + 两次命令）。打印机不可达时最长约 15 秒。

### `POST /api/staged`

暂存成片。**不打印，不耗纸。**

请求体是**原始 JPEG 字节**（不是 multipart）。

```bash
curl -X POST http://127.0.0.1:8000/api/staged \
     -H 'content-type: image/jpeg' \
     -H 'X-Source-Name: photo.jpg' \
     --data-binary @sheet.jpg
```

```json
{ "ok": true, "bytes": 501005, "kb": 489.3 }
```

`X-Source-Name` 可选，仅用于显示（支持中文，需 URL 编码）。

错误：

| 状态 | 原因 |
|---|---|
| `400` | 请求体为空 → `{"detail":"没有收到图片数据"}` |
| `400` | 不是 JPEG → `{"detail":"成片必须是 JPEG（未检测到 JPEG 文件头）"}` |
| `413` | 超过 2048KB → `{"detail":"成片 2100KB 超过上限 2048KB。请降低导出质量后重试。"}` |

> **字节原样保存**，服务端不重新编码。这是刻意的：静默降质会让"打印的"与
> "你确认的"不一致。

### `GET /api/staged`

查询已暂存内容。

```json
{ "ok": true, "bytes": 501005, "stagedAt": 1792060945902, "sourceName": "photo.jpg" }
```

未暂存时 `404`：`{"detail":"尚未生成成片"}`

### `DELETE /api/staged`

清除暂存。

```json
{ "ok": true }
```

### `POST /api/print`

**开始打印已暂存的成片。消耗一张相纸。**

> **需要显式开启打印。** 服务默认拒绝启动打印任务，必须先设
> `ALLOW_PRINTING=1` 启动，否则返回 409：
>
> ```bash
> ALLOW_PRINTING=1 npm run start:dev
> ```
>
> 这样测试、脚本或误触的请求都不会浪费相纸。只读操作不受影响。

**立即返回**（202），不等打印完成——一次打印约需 75 秒（4 秒传输 + 70 秒打印），
让 HTTP 请求挂那么久会让客户端超时，也无法展示进度。

```bash
curl -X POST http://127.0.0.1:8000/api/print
```

```json
{
  "id": "job-mv9i7lmz-fim4",
  "sourceName": "photo.jpg",
  "bytes": 501005,
  "frames": 508,
  "state": "queued",
  "progress": 0,
  "createdAt": 1792066645835
}
```

响应头带 `Location: /api/print/job-mv9i7lmz-fim4`。

错误：

| 状态 | 原因 |
|---|---|
| `400` | 未暂存 → `{"message":"尚未暂存成片，请先 POST /api/staged"}` |
| `400` | 打印机忙 → `{"message":"打印机忙：正在处理任务 job-xxx"}` |

### `GET /api/print/:id`

查询任务状态与进度。

```json
{
  "id": "job-mv9i7lmz-fim4",
  "state": "printing",
  "progress": 0.5,
  "bytes": 501005,
  "frames": 508,
  "printerJobId": 72,
  "printTimeMs": 41230,
  "startedAt": 1792066645836
}
```

状态流转：

| 状态 | 含义 |
|---|---|
| `queued` | 已接受，等待取用打印机 |
| `transferring` | 正在传输成片（约 4 秒） |
| `printing` | 打印机正在出纸（约 70 秒） |
| `finished` | 完成 |
| `failed` | 失败，`error` 字段说明原因 |

失败示例：

```json
{
  "state": "failed",
  "error": "已配对的蓝牙设备都无法打开打印通道。请依次确认：\n  1. 打印机已开机…"
}
```

### `GET /api/print/:id/events`

以 **Server-Sent Events** 推送状态变化，无需轮询。订阅后立即收到当前状态，
之后每秒推送一次直到任务进入终态。

```bash
curl -N http://127.0.0.1:8000/api/print/job-mv9i7lmz-fim4/events
```

```
id: 1
data: {"id":"job-...","state":"queued","progress":0,...}

id: 2
data: {"id":"job-...","state":"transferring","progress":0.1,...}

id: 3
data: {"id":"job-...","state":"printing","progress":0.5,...}

id: 4
data: {"id":"job-...","state":"finished","progress":1,...}
```

浏览器端示例：

```js
const es = new EventSource(`/api/print/${jobId}/events`)
es.onmessage = (e) => {
  const job = JSON.parse(e.data)
  console.log(job.state, `${Math.round(job.progress * 100)}%`)
  if (job.state === 'finished' || job.state === 'failed') es.close()
}
```

### `GET /api/print`

最近的任务列表（最多 50 条，已完成的任务保留 30 分钟）。

```json
{ "jobs": [ { "id": "job-...", "state": "finished" } ] }
```

---

## 命令行参数

```
node src/index.ts [选项]

  --port <n>       监听端口（默认 8000）
  --host <addr>    监听地址（默认 127.0.0.1）
  --address <mac>  指定打印机地址，跳过自动发现
  --verbose        打印蓝牙通信细节
  --help           显示帮助
```

配置优先用环境变量（对三种启动方式都有效）：

| 变量 | 作用 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | `8000` |
| `HOST` | 监听地址 | `127.0.0.1` |
| `PRINTER_ADDRESS` | 指定打印机地址，跳过自动发现 | 空（自动发现） |
| `MAX_IMAGE_KB` | 成片大小上限 | `2048` |

```bash
PRINTER_ADDRESS=f0-13-c1-xx-xx-xx PORT=8080 npm run start:dev
```

**优先级**：CLI 参数 > 环境变量 > 默认值。但见下方关于 `nest start` 吞参数的说明。

---

## 自动发现打印机

默认不需要任何配置。发现流程：

1. 枚举系统已知的蓝牙设备（含已配对与近期出现的）
2. 按名称可能性排序：包含 `printer` / `打印` / `米家` / `xiaomi` / `hannto` 的排前面
3. 依次尝试打开 RFCOMM 通道，**第一个成功的即采用**

第 3 步是安全的：连错设备会在打开通道时失败，**不会写入任何数据、不会打印**。

### 何时需要手动指定

- 打印机被重命名，且新名字不含上述关键词（仍会被尝试，只是排在后面，通常仍能找到）
- 系统里有**多台**同类打印机
- 自动发现因权限等原因失败

```bash
# 用环境变量（推荐）
PRINTER_ADDRESS=f0-13-c1-xx-xx-xx npm start

# 或用运行构建产物的方式传 CLI 参数
npm run build && npm run start:prod -- --address f0-13-c1-xx-xx-xx
```

> **注意**：`npm start -- --address ...` **不可用**。`npm start` 底层是
> `nest start`，它会吞掉 `--` 之后的参数，CLI 参数传不到应用。
> 需要 CLI 参数时用 `start:prod`（等价于 `node dist/main`），或直接用上面
> 的环境变量。

地址格式为 `aa-bb-cc-dd-ee-ff`（小写、连字符分隔）。

---

## 打印一张的完整流程

```bash
# 1. 启动
npm start

# 2. 确认打印机就绪（只读）
curl http://127.0.0.1:8000/api/printer/status | grep -q '"reachable":true' \
  && echo "打印机就绪"

# 3. 准备成片
magick input.png -resize 1200x1800^ -gravity center -extent 1200x1800 \
       -quality 92 sheet.jpg

# 4. 暂存（不打印）
curl -X POST http://127.0.0.1:8000/api/staged \
     -H 'content-type: image/jpeg' --data-binary @sheet.jpg

# 5. 打印（消耗一张相纸；需 ALLOW_PRINTING=1 启动服务）
curl -X POST http://127.0.0.1:8000/api/print \
```

第 4 步与第 5 步分开是有意的：暂存可以反复做（不耗纸），
打印只在确认后才执行。

---

## 故障排查

### 启动时报「原生模块未编译」

```
蓝牙: ⚠ 原生模块未编译 —— 请运行 npm run build:native
```

未装 Xcode 命令行工具。执行：

```bash
xcode-select --install
npm run build:native
```

### 「找不到任何蓝牙设备」

1. 打印机是否开机？休眠时按一下按钮
2. 是否已在「系统设置 → 蓝牙」里配对？
3. 蓝牙是否已打开？

### 「已配对的蓝牙设备都无法打开打印通道」

按提示依次检查：

1. **打印机已开机**（休眠需按按钮唤醒）
2. **没有另一个实例占用**——RFCOMM 通道是**独占的**，同时只能有一个连接。
   若 `npm start` 正在运行，就不能同时跑 `verify-print.mjs`
3. **手机上的米家 App 是否连着**——也会占用

### 「打印机不可达」

打印机休眠了。按一下打印机按钮唤醒。

这是热升华打印机的正常行为：闲置一段时间后自动休眠以省电。

### 「未收到 SERVER_HELLO_DH」

握手第一阶段无响应。可能：

- 打印机刚被另一个连接占用，稍等几秒重试
- 打印机正在执行其他任务

### 「握手被拒绝：nok」

会话密钥不一致。若你在改协议代码，检查 **DH 的两处补位规则**：

| 值 | 补位 |
|---|---|
| 客户端公钥 `rb` | 十六进制文本，**前面**补 `'0'`（0x30） |
| 会话密钥 `k` | 十六进制文本，**末尾**补 `0x00` |

两者互为镜像，搞反就返回 `nok`。详见 [PROTOCOL.md](PROTOCOL.md#两处补位规则极易搞反)。

### 「命令 xxx 无响应」但打印机是好的

**协议是严格一问一答**。若你的代码并发发送了两条命令，两个等待者会争抢同一条
回复，其中一个就会报"无响应"。

不要用 `Promise.all` 并发发命令——必须串行。

### 打印出来是空白 / 尺寸不对

服务端不做任何图像处理，**它打印的就是你交给它的字节**。检查：

1. 成片是否真的是 1200×1800？`identify sheet.jpg`
2. 是否先 `POST /api/staged` 再 `POST /api/print`？暂存的内容才是被打印的
3. 是否在暂存后又生成了新图但忘了重新暂存？

### 请求卡住很久

- `/api/printer/status` 在打印机不可达时最长阻塞约 15 秒（原生连接是同步的）
- `POST /api/print` **立即返回**（这是异步任务模型的目的）；
  要等结果需轮询 `GET /api/print/:id` 或订阅 SSE

---

## 不消耗相纸的检查方式

**相纸是消耗品。** 以下操作都不会打印，可以放心使用：

```bash
# 全部单元测试（58 项：协议 41 + 接口 17，都不接触硬件）
npm test

# 类型检查
npm run typecheck

# 只读探测：握手 + 电量 + 固件
curl http://127.0.0.1:8000/api/printer/status

# 暂存成片（只写文件，不打印）
curl -X POST http://127.0.0.1:8000/api/staged \
     -H 'content-type: image/jpeg' --data-binary @sheet.jpg
```

### 关于 `verify-print.mjs`

仓库里的 `verify-print.mjs` 是**真机打印验证脚本**，会消耗相纸。它要求显式确认：

```bash
node verify-print.mjs sheet.jpg --yes-consume-one-sheet
```

不带该参数时会被拒绝。

打印链路已经完成验证（任务 71/72/73 均成功出纸），**通常没有再次运行的必要**。
有 58 项离线测试（协议 41 + 接口 17），逻辑正确性不需要真机。

---

## 作为库使用

除了 HTTP 接口，也可以直接引用协议与会话模块：

```ts
import { BluetoothLink } from './src/bluetooth.ts'
import { PrintSession } from './src/session.ts'

const link = new BluetoothLink()          // 地址留空 = 自动发现
const session = new PrintSession(link)

try {
  await session.connect()                 // 连接 + DH 握手

  const status = await session.status()
  console.log(`电量 ${status.battery}%`)

  // 只发命令，不打印
  const info = await session.deviceInfo()
  console.log(info.model, info.fw)

  // 打印需要自己控制流程：
  // const jobId = await session.createJob(bytes)
  // await session.sendFile(file, jobId)
  // await session.waitForJob(jobId)
} finally {
  await session.close()
}
```

`src/protocol.ts` 是纯函数模块（帧编解码、AES、DH、分片），
可以单独使用，无 I/O、无副作用，测试友好。

---

## 延伸阅读

| 文档 | 内容 |
|---|---|
| [README.md](../README.md) | 项目概览、限制、设计取舍 |
| [PROTOCOL.md](PROTOCOL.md) | 帧格式、DH 握手、加密、分片（完整协议规格） |
| [INTEGRATION.md](INTEGRATION.md) | 前后端联调指南 |
| [REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md) | 协议还原过程与证据 |
| [VERIFICATION.md](VERIFICATION.md) | 真机验证记录 |
| [adr/](adr/) | 关键决策记录 |
