# 前后端联调指南

本文档给前端开发者：接口怎么调、有哪些坑、如何自测。所有示例都经过实际调用验证。

- 只想接上跑通 → [第一步：让浏览器能访问](#第一步让浏览器能访问)
- 写上传逻辑 → [上传成片](#上传成片最容易踩坑的一步)
- 写打印流程 → [打印是异步的](#打印是异步的)
- 出问题了 → [常见问题](#常见问题)

---

## 目录

- [启动与自检](#启动与自检)
- [第一步：让浏览器能访问](#第一步让浏览器能访问)
- [接口总览](#接口总览)
- [准备成片](#准备成片)
- [上传成片（最容易踩坑的一步）](#上传成片最容易踩坑的一步)
- [打印是异步的](#打印是异步的)
- [订阅进度（SSE）](#订阅进度sse)
- [错误处理](#错误处理)
- [推荐的前端状态机](#推荐的前端状态机)
- [常见问题](#常见问题)
- [联调检查清单](#联调检查清单)

---

## 启动与自检

```bash
cd pocket-printer
npm install
npm run start:dev        # 开发模式，改动自动重启 → http://127.0.0.1:8000
```

**默认不打印**。要真正打印必须显式开启，否则 `POST /api/print` 返回 409：

```bash
ALLOW_PRINTING=1 npm run start:dev
```

联调阶段**建议不要开** `ALLOW_PRINTING`：这样即使误触发打印也不会消耗相纸。
需要验证完整打印流程时再开。

自检（都不耗纸）：

```bash
curl http://127.0.0.1:8000/api/health          # 服务是否活着
curl http://127.0.0.1:8000/api/device          # 蓝牙是否可用
curl http://127.0.0.1:8000/api/printer/status  # 打印机是否可达（会连真机，约 1–30 秒）
```

---

## 第一步：让浏览器能访问

**这是最常见的第一个阻塞。** 前端 dev server（Vite 默认 `5173`）与后端 `8000` 不同源，
浏览器会拦截所有请求，除非后端允许。

后端**默认关闭 CORS**。联调时用环境变量列出前端来源：

```bash
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 npm run start:dev
```

多个来源用逗号分隔，**不要有空格**（前后空格会被自动去掉，但仍建议不写）。

### 两个容易忽略的点

**1. SSE 必须依赖 CORS 头，无法绕过。**
`EventSource` 不能像 `fetch` 那样用自定义头绕开限制。若 CORS 没配对，
进度订阅会静默失败（浏览器控制台有报错，网络面板可能只显示一个失败的请求）。

**2. 上传自定义头 `X-Source-Name` 需要预检。**
后端已允许该头。若你自己加了别的自定义头，需要在后端 `allowedHeaders` 中补充。

### 验证 CORS 已生效

```bash
curl -s -i -H "Origin: http://localhost:5173" http://127.0.0.1:8000/api/health \
  | grep -i access-control
```

应看到：

```
Access-Control-Allow-Origin: http://localhost:5173
```

看不到这个头就是没配对，前端一定失败。

### 另一种做法：让 Vite 代理（推荐）

不在后端开 CORS，而在前端 dev server 里代理，**同源就没有跨域问题**：

```ts
// vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        // SSE 需要保持连接不缓冲
        ws: false,
      },
    },
  },
})
```

这样前端代码里直接写 `/api/...`，CORS 完全不需要。**本项目的旧前端就是这样做的。**

---

## 接口总览

基地址：`http://127.0.0.1:8000`

| 方法 | 路径 | 是否耗纸 | 说明 |
|---|---|---|---|
| `GET` | `/api/health` | ❌ | 服务信息、成片尺寸要求、大小上限 |
| `GET` | `/api/device` | ❌ | 蓝牙可用性、发现的候选设备、`busy` |
| `GET` | `/api/printer/status` | ❌ | 真机探测：电量、固件、状态（**阻塞数秒**） |
| `POST` | `/api/staged` | ❌ | 上传成片字节 |
| `GET` | `/api/staged` | ❌ | 查询已上传信息 |
| `GET` | `/api/staged/image` | ❌ | 取回已上传的图片 |
| `DELETE` | `/api/staged` | ❌ | 清除已上传 |
| `POST` | `/api/print` | ✅ | **开始打印**，立即返回任务 |
| `GET` | `/api/print` | ❌ | 任务列表 |
| `GET` | `/api/print/:id` | ❌ | 单个任务状态 |
| `GET` | `/api/print/:id/events` | ❌ | 任务进度（SSE） |

一个最小的端到端流程：

```
GET  /api/health          → 确认服务在，读 maxImageKb
GET  /api/device          → 确认蓝牙可用，拿到候选设备
POST /api/staged          → 上传 1200×1800 的 JPEG
POST /api/print           → 202 + 任务对象
GET  /api/print/:id/events→ 订阅进度直到 finished
```

---

## 准备成片

后端**不做任何图像处理**。前端必须把图渲染成：

| 项 | 值 | 来源 |
|---|---|---|
| 尺寸 | **1200 × 1800**（2:3 竖版） | `/api/health` 的 `job` |
| 格式 | **JPEG** | 硬性要求 |
| 大小 | ≤ `/api/health` 的 `maxImageKb`（默认 2048KB） | 插件默认值 |

浏览器里导出：

```ts
async function exportSheet(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('导出失败'))),
      'image/jpeg',
      0.92,
    )
  })
}
```

**两个实测数据**（供参考）：

- 1200×1800 的 JPEG 在质量 0.92 时约 **40–500KB**，远低于 2048KB 上限
- 不必为了控制大小牺牲画质；若真超限，后端会**明确报错**而不是静默降质

---

## 上传成片（最容易踩坑的一步）

### 契约

```
POST /api/staged
Content-Type: image/jpeg        ← 或任意类型，见下
X-Source-Name: <URL 编码的文件名>  ← 可选，仅用于显示

<原始 JPEG 字节>
```

请求体是**原始字节**，不是 multipart，不是 base64，不是 JSON。

```ts
async function stage(blob: Blob, name: string) {
  const res = await fetch('/api/staged', {
    method: 'POST',
    headers: {
      'Content-Type': 'image/jpeg',
      // 文件名可选；含中文/空格必须 URL 编码，否则 header 非法
      'X-Source-Name': encodeURIComponent(name),
    },
    body: blob,        // 直接传 Blob，浏览器会以原始字节发送
  })
  if (!res.ok) throw new Error((await res.json()).message)
  return res.json()    // { ok: true, bytes: 501005, kb: 489.3 }
}
```

### ⚠️ 不要用 FormData

这是最可能犯的错：

```ts
// ❌ 错误：后端收到的是 multipart 信封，不是 JPEG
const fd = new FormData()
fd.append('file', blob)
await fetch('/api/staged', { method: 'POST', body: fd })
```

实际返回：

```
400 {"statusCode":400,"message":"成片必须是 JPEG（未检测到 JPEG 文件头）"}
```

报错信息会让人以为图片有问题，其实是调用方式不对。**直接传 Blob 即可。**

### 精确响应

| 状态 | 响应 | 原因 |
|---|---|---|
| `200` | `{"ok":true,"bytes":501005,"kb":489.3}` | 成功 |
| `400` | `{"statusCode":400,"message":"没有收到图片数据"}` | 请求体为空 |
| `400` | `{"statusCode":400,"message":"成片必须是 JPEG（未检测到 JPEG 文件头）"}` | 不是 JPEG（或用了 FormData） |
| `413` | `{"statusCode":413,"message":"成片超过上限 2048KB，请降低导出质量后重试"}` | 超过 `maxImageKb` |

上传**不耗纸**，可以反复调用（后一次覆盖前一次）。

### 确认上传的是你以为的那张图

```ts
// 取回并显示，做一次自检
const img = document.querySelector('img')!
img.src = '/api/staged/image'
```

也可以用 `GET /api/staged` 核对字节数：

```json
{ "ok": true, "bytes": 501005, "stagedAt": 1792071125805, "sourceName": "photo.jpg" }
```

---

## 打印是异步的

一次打印约 **75 秒**（4 秒传输 + 70 秒打印）。`POST /api/print` **立即返回**，
不会等打印完成——否则请求早就超时了。

### 发起打印

```ts
const res = await fetch('/api/print', { method: 'POST' })
if (res.status === 409) {
  // 两种可能：未开启 ALLOW_PRINTING，或打印机正忙
  const { message } = await res.json()
  throw new Error(message)
}
const job = await res.json()
// 202 Accepted
// { id: "job-mv9kurb1-kuyx", state: "queued", progress: 0, bytes: 501005, frames: 508, ... }
// 响应头 Location: /api/print/job-mv9kurb1-kuyx
```

**`POST /api/print` 没有请求体**，不需要 `content-type`。

### 任务对象

```ts
interface PrintJob {
  id: string                    // 任务 id
  sourceName: string            // 上传时的文件名（仅显示）
  bytes: number                 // 成片字节数
  frames: number                // 分帧数（508 表示 489KB 的图）
  state: 'queued' | 'transferring' | 'printing' | 'finished' | 'failed' | 'cancelled'
  progress: number              // 0..1
  createdAt: number             // 毫秒时间戳
  startedAt?: number
  finishedAt?: number
  printerJobId?: number         // 打印机分配的任务号
  printTimeMs?: number          // 实际打印耗时
  error?: string                // state 为 failed 时的原因
}
```

**`printerJobId` 是判断"是否真的开始打印"的可靠标志**：它只在打印机接受任务后出现。
若任务失败且没有它，说明失败在连接阶段，打印机根本没收到数据。

### 状态流转

```
queued → transferring → printing → finished
                              ↘ failed
```

| 状态 | 含义 | 大致耗时 |
|---|---|---|
| `queued` | 已接受，等待取用打印机 | 立即 |
| `transferring` | 正在传输成片 | ~4 秒 |
| `printing` | 打印机正在出纸 | ~70 秒 |
| `finished` | 完成 | — |
| `failed` | 失败，看 `error` | — |

**进度不是线性的**：`progress` 在传输阶段到 0.5，之后保持 0.5 直到结束变 1。
因为打印机不报告打印百分比。若要按时间估算，传输约 4 秒，打印约 70 秒。

---

## 订阅进度（SSE）

### 推荐：EventSource

```ts
function followPrint(jobId: string) {
  const es = new EventSource(`/api/print/${jobId}/events`)

  es.onmessage = (e) => {
    const job: PrintJob = JSON.parse(e.data)
    render(job)
    if (job.state === 'finished' || job.state === 'failed') {
      es.close()          // 服务端也会关闭，但显式关闭更干净
    }
  }

  es.onerror = () => {
    // SSE 断线时浏览器会自动重连；终态后服务端关闭也会触发这里
    es.close()
  }

  return () => es.close()  // 组件卸载时调用
}
```

### 线格式（实测）

服务端发送的是标准 SSE：

```
\n
id: 1\n
data: {"id":"job-...","state":"printing","progress":0.5,...}\n
\n
```

`EventSource` 会自动解析，`e.data` 是那行 JSON。

### 关键行为

| 行为 | 说明 |
|---|---|
| **订阅立即收到当前状态** | 不用等下一次变化，所以中途订阅也能看到进度 |
| **每秒推送一次** | 由打印机轮询驱动 |
| **终态后关闭连接** | 收到 `finished`/`failed` 后服务端主动结束流 |
| **任务不存在 → 404** | 订阅前先确认 job id 正确 |

### 备选：轮询

不想用 SSE 就轮询，**但不要超过每秒一次**（任务状态不会更快变化）：

```ts
async function pollPrint(jobId: string) {
  for (;;) {
    const job = await (await fetch(`/api/print/${jobId}`)).json()
    render(job)
    if (job.state === 'finished' || job.state === 'failed') return job
    await new Promise((r) => setTimeout(r, 1000))
  }
}
```

---

## 错误处理

### 错误响应统一格式

```json
{ "statusCode": 400, "message": "成片必须是 JPEG（未检测到 JPEG 文件头）" }
```

`message` 是**可以直接展示给用户的中文说明**，不需要前端再翻译。

### 状态码对照

| 状态 | 含义 | 前端应做什么 |
|---|---|---|
| `200` | 成功 | — |
| `202` | 打印任务已接受（异步） | 拿 `id` 去订阅进度 |
| `400` | 请求有问题 | 展示 `message`，多为调用方式错误 |
| `404` | 资源不存在 | 任务 id 错误，或已完成被清理 |
| `409` | 冲突 | 打印被禁用（未开 `ALLOW_PRINTING`）或打印机忙 |
| `413` | 图片过大 | 提示用户降低导出质量 |
| `500` | 服务内部错误 | 展示 `message`，并查看后端日志 |

**没有 503。** 打印机不可达不是"请求失败"，而是"探测成功、结果是不可达"：
`GET /api/printer/status` 返回 200 + `reachable: false`，
打印任务则返回 202 并在任务记录上异步标记失败。见下方说明。

### 三个特殊的错误场景

**① 打印机休眠**

```
{"statusCode":200,"available":true,"reachable":false,"handshake_ok":false,
 "message":"打印机不可达：请确认已开机（休眠后需要按一下按钮唤醒）。"}
```

注意 `GET /api/printer/status` 的失败是 **HTTP 200 + `reachable: false`**，
不是错误状态码——因为"探测完成，结果是不可达"本身是一次成功的探测。
前端要判断 `reachable` 而不是只看 HTTP 状态。

**② 打印被禁用（联调时的默认状态）**

```json
{"statusCode":409,"message":"打印已被禁用（未设置 ALLOW_PRINTING=1）。..."}
```

**③ 打印机忙**

```json
{"statusCode":409,"message":"打印机忙：正在处理任务 job-xxx"}
```

前端应禁用打印按钮，或提示用户等待。

---

## 推荐的前端状态机

```
        ┌──────────┐
        │  选择图片 │
        └────┬─────┘
             ↓
        ┌──────────┐   POST /api/staged
        │  已上传   │ ←── 可反复重传（不耗纸）
        └────┬─────┘
             ↓  用户确认
        ┌──────────┐   POST /api/print → 202
        │  打印中   │ ←── 订阅 SSE 或轮询
        └────┬─────┘
             ↓
     ┌───────┴────────┐
     ↓                ↓
┌─────────┐     ┌─────────┐
│ finished │     │  failed  │
└─────────┘     └─────────┘
```

要点：

1. **上传与打印分开**。上传免费、可重复；打印消耗相纸、不可撤销。
2. **打印前必须让用户确认**。这是产品的核心约束，不要因为"少一次点击"而省略。
3. **打印中禁止重复提交**。用 `GET /api/device` 的 `busy` 字段，或自己维护状态。

### 确认对话框要显示的信息

用户需要知道自己在确认什么：

```ts
// 从暂存信息里取，都是后端确认过的真实数据
const info = await (await fetch('/api/staged')).json()
console.log(`将打印 ${(info.bytes / 1024).toFixed(0)}KB 的成片，消耗 1 张相纸`)
```

**建议同时显示 `GET /api/staged/image`**——让用户看到真正要打印的那张图，
而不是以为在打印某张图。后端保证"上传什么就打印什么"，不会重新编码。

---

## 常见问题

### 浏览器报 CORS 错误

后端没开 CORS，或来源没列进去。见[第一步](#第一步让浏览器能访问)。

```
Access to fetch at 'http://127.0.0.1:8000/api/health' from origin
'http://localhost:5173' has been blocked by CORS policy
```

### 上传报「成片必须是 JPEG」

九成是用了 `FormData`。**直接传 Blob**，见[上传成片](#上传成片最容易踩坑的一步)。

也可能是 `canvas.toBlob` 传了 PNG 格式，检查第二个参数是 `'image/jpeg'`。

### 打印返回 409

两种原因，看 `message`：

- 含 `ALLOW_PRINTING` → 后端启动时没开打印
- 含 `打印机忙` → 已有任务在跑

### SSE 收不到任何事件

1. CORS 是否配对（`EventSource` 无法绕过）
2. 是否用了 Vite 代理但没配 `ws: false` 或代理未生效
3. 用 `curl -N http://127.0.0.1:8000/api/print/<id>/events` 确认服务端确实在推

```bash
# 直接验证 SSE 是否正常
curl -N http://127.0.0.1:8000/api/print/<job-id>/events
```

### ⚠️ 连接打印机期间，整个 API 会短暂无响应

**这是联调时最容易误判的问题。** 实测数据：

| 时刻 | `GET /api/health` 响应时间 |
|---|---|
| 空闲 | **0.001 秒** |
| 提交打印后 0.5 秒 | **20 秒（超时）** |
| 提交打印后 2.5 秒 | 7.9 秒 |
| 任务结束、连接失败后 | 0.001 秒 |

**原因**：访问 macOS 蓝牙串口必须用原生模块，而它的 `connect()` 是**同步调用**，
最多阻塞 15 秒等待基带连接。Node 是单线程的，这个同步调用会**阻塞整个事件循环**
——期间所有端点（包括 `/api/health`）都不响应。

这不是 bug，是为规避 IOBluetooth 的跨线程问题而做的取舍（见
[ADR-0001](adr/0001-native-addon-for-bluetooth.md)），但前端必须知道。

**前端要做的**：

1. **给所有请求设足超时**，至少 40 秒。默认超时（如 `fetch` 无限、
   axios 0、某些客户端 10 秒）会导致打印刚开始就报"网络错误"。
2. **打印期间不要做其他请求**。轮询 `GET /api/print/:id` 或订阅 SSE 是可以的——
   它们本身就要等；但不要在此时并发检查电量或设备状态，那只会一起卡住。
3. **把"无响应"与"打印失败"区分开**。请求超时不代表打印失败：
   打印机若休眠，任务会在连接阶段失败并记录在任务对象上；
   若打印机正常，任务会继续执行。**判断依据始终是任务状态，不是 HTTP 请求是否成功。**
4. **给用户明确的等待反馈**。提交打印后立刻显示"正在连接打印机…"，
   不要因为几秒内没有响应就显示错误。

```ts
// 推荐：给打印相关请求单独设长超时
const res = await fetch('/api/print', {
  method: 'POST',
  signal: AbortSignal.timeout(45_000),   // 默认太快会误报失败
})
```

### `GET /api/printer/status` 很慢（几秒到 30 秒）

与上一条同源：它会**真的去连打印机**。连上约 1 秒；打印机休眠时要等连接超时
（最长约 30 秒，有总预算控制），期间整个 API 都会卡住。

前端建议：

- 不要放在页面加载的关键路径上
- 给用户明确的"检查中"反馈
- 请求超时设 ≥ 35 秒，或用一个"检查打印机"按钮手动触发
- **不要在打印进行中调用它**

### 任务失败且没有 `printerJobId`

失败在连接阶段，打印机**没有收到任何数据、没有消耗相纸**。看 `error` 字段，
通常是打印机休眠或通道被占用。

---

## 联调检查清单

后端：

```bash
cd pocket-printer
npm install
npm run start:dev                                    # 或加 CORS_ORIGINS / ALLOW_PRINTING
curl http://127.0.0.1:8000/api/health                # {"ok":true,...}
curl http://127.0.0.1:8000/api/device                # mac.available: true
```

前端：

- [ ] dev server 能访问 `/api/health`（无 CORS 报错）
- [ ] 能把画布导出成 1200×1800 的 JPEG
- [ ] `POST /api/staged` 返回 200（不是 400）
- [ ] `GET /api/staged/image` 显示的图与预期一致
- [ ] `POST /api/print` 返回 202 并拿到 job id
- [ ] SSE 能收到 `printing` 状态
- [ ] 任务结束能收到 `finished` 或 `failed`
- [ ] 打印按钮在 `busy` 时禁用
- [ ] 打印前有确认步骤，并提示"消耗 1 张相纸"
- [ ] 所有请求的超时 ≥ 40 秒（否则连接阶段会误报网络错误）
- [ ] 打印期间的短暂无响应有"连接中"提示，不显示为错误

**联调阶段建议不开 `ALLOW_PRINTING`**，用 409 验证错误分支即可。
最后再开一次，验证真实打印。

---

## 相关文档

| 文档 | 内容 |
|---|---|
| [USAGE.md](USAGE.md) | 后端使用指南（含故障排查） |
| [PROTOCOL.md](PROTOCOL.md) | 蓝牙协议规格（前端不需要看） |
| [../README.md](../README.md) | 项目概览 |
