# pocket-printer

不进入米家 App，直接通过蓝牙把照片打印到 **米家口袋打印机 Pro**。

一个 Node.js 送印服务：接收已渲染好的位图，交给打印机。图像处理（裁剪、旋转、
缩放、导出成片）由调用方完成——本项目**不做任何图像处理**。

- 只支持 **macOS**（蓝牙经典串口需要 IOBluetooth，见[为什么需要原生模块](#为什么需要原生模块)）
- 已在 **米家口袋打印机 Pro**（`xiaomi.printer.ricott`，固件 2.1.2_0041）真机验证
- 无需小米账号，无需设备 token（[为什么](#不需要-token)）

## 环境要求

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 22 | 运行构建产物（NestJS 需要构建，见下） |
| macOS | 蓝牙经典串口 |
| Xcode 命令行工具 | 编译原生模块（`xcode-select --install`） |
| 已配对的打印机 | 「系统设置 → 蓝牙」里配对一次 |

## 快速开始

```bash
npm install          # 会自动编译原生蓝牙模块
npm run build        # NestJS 需要构建（装饰器无法由类型擦除处理）
npm start            # http://127.0.0.1:8000
```

启动时会自动发现打印机：

```
口袋打印机 · 送印服务（Node v24.16.0）
  地址: http://127.0.0.1:8000
  蓝牙: 自动发现（3 台候选设备）
        f0-13-c1-xx-xx-xx  米家口袋打印机Pro-A2BF
        ...
```

> 更详细的使用说明（含故障排查、语言示例）见 **[docs/USAGE.md](docs/USAGE.md)**。

## 用法

```bash
# 1. 查看打印机状态（只读，不耗纸）
curl http://127.0.0.1:8000/api/printer/status

# 2. 暂存成片（必须是 1200×1800 的 JPEG）
curl -X POST http://127.0.0.1:8000/api/staged \
     -H 'content-type: image/jpeg' \
     --data-binary @photo.jpg

# 3. 开始打印（消耗一张相纸）—— 立即返回任务对象
curl -X POST http://127.0.0.1:8000/api/print
# → 202 {"id":"job-xxx","state":"queued","progress":0}

# 4. 查询进度（打印约需 75 秒）
curl http://127.0.0.1:8000/api/print/job-xxx
# → {"state":"printing","progress":0.5,...}

# 或订阅 SSE，自动推送状态变化
curl -N http://127.0.0.1:8000/api/print/job-xxx/events
```

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 服务信息、成片尺寸、大小上限 |
| `GET` | `/api/device` | 蓝牙可用性 + 发现的候选设备 |
| `GET` | `/api/printer/status` | 握手、电量、固件、纸张状态（只读） |
| `POST` | `/api/staged` | 暂存成片字节（原样保存，不重新编码） |
| `GET` | `/api/staged` | 查询已暂存内容 |
| `GET` | `/api/staged/image` | 取回暂存的图片 |
| `DELETE` | `/api/staged` | 清除暂存 |
| `POST` | `/api/print` | **开始打印**，立即返回任务对象（**消耗相纸**） |
| `GET` | `/api/print/:id` | 查询任务状态 |
| `GET` | `/api/print/:id/events` | 订阅进度（SSE） |

### 命令行参数

```
--port <n>       监听端口（默认 8000）
--host <addr>    监听地址（默认 127.0.0.1）
--address <mac>  指定打印机地址，跳过自动发现
--verbose        打印蓝牙通信细节
```

打印机地址默认为**自动发现**：枚举已配对设备，按名称可能性排序后逐个尝试连接。

## 成片要求

| 项 | 值 | 来源 |
|---|---|---|
| 尺寸 | **1200 × 1800**（2:3 竖版） | 插件 `jobInfo.width/height` |
| 格式 | JPEG | 打印机只接受 JPEG |
| 大小上限 | **2048 KB** | 插件 `imageSizeQualityCompress` 默认值 |

超过上限会**明确报错**，不会静默降质——静默降质正是"印出来和预览不符"的根源。

调用方负责把照片渲染成这个尺寸。若只需原样打印一张图而不做构图调整，
把图片缩放/补白到 1200×1800 即可。

## 不需要 token

打印**不需要**设备 token，也**不需要**小米账号。

插件里有两条独立的加密路径：

| 路径 | 加密 | 需要 token |
|---|---|---|
| **蓝牙经典打印**（本项目使用） | `ENCRYPT_ECB`：DH 握手现场派生会话密钥 | ❌ |
| BLE 通道 | `ENCRYPT_MIJIA`：`securityLock.encryptMessageWithToken()` | ✅ |

本项目走前者。设备 token 由云端 RPC 下发（APK 中的 `getDevicePropFromServer`），
仅服务于 BLE 那条路，与打印无关。

## 真机验证

**任务 71 / 72 打印成功并出纸**，与之前 Swift 实现的参数完全一致：

| | Node | Swift（迁移前） |
|---|---|---|
| 帧数 | **508** | **508** |
| MTU | 650 | 650 |
| 传输耗时 | 4.3s | 4.1s |
| 出纸 | 1 张 | 1 张 |

复现需要**显式确认**——相纸是消耗品，且打印链路已验证通过：

```bash
node verify-print.mjs <1200x1800.jpg> --yes-consume-one-sheet
```

不带该参数时脚本会拒绝运行并说明替代的离线检查方式。
确需真机验证时再加，不要为了"确认代码能跑"而打印。

协议层另有与 Swift 实现的**逐字节对比**：握手帧、AES 块、1014 字节的加密文件帧等
5 个用例全部一致。

## 测试

```bash
npm test          # 58 项，全部离线运行，不需要打印机
npm run typecheck
```

协议层是纯函数（帧编解码、AES、DH、分片），因此绝大部分逻辑无需硬件即可验证。

## 为什么需要原生模块

macOS 的蓝牙经典串口（SPP）只能通过 Objective-C 的 `IOBluetooth` 框架访问，
Node 没有 ObjC 桥，也没有可用的纯 JS 库。因此有 `native/` 下约 280 行 ObjC++ 的
N-API 插件。

### 走过的弯路（不必重试）

曾尝试用 `serialport` 打开 macOS 为已配对设备创建的 `/dev/cu.*` 设备节点。
**这条路走不通**：写进去的帧字节完全正确（与 Swift 实现逐字节一致），但打印机
一个字节都不回复——那个设备节点不承载本打印机的 RFCOMM 通道。

### 三个不能"顺手优化"的地方

1. **RFCOMM 通道号必须硬编码为 1。** 打印机的 SDP 记录里 SPP UUID（`0x1101`）
   指向**通道 22**，但 22 连不上、1 才能用。改成"自动发现通道"会失败。

2. **委托回调的 `length:` 必须是 `size_t`。** 写成 `UInt16` 会截断，每帧长度读成 0，
   现象与"打印机完全不响应"一模一样。

3. **协议是严格一问一答。** 两条命令同时在途时，两个等待者会争抢同一条回复，
   其中一个报"无响应"——而打印机是好的。

### 一个不直观的机制

IOBluetooth 通过**委托回调**送数据，回调由**打开通道那个线程的 CFRunLoop** 派发。
Node 主线程跑 libuv 而非 CFRunLoop，所以朴素写法的插件**一个字节都收不到**。
解法是用一个 5ms 的 `uv_timer` 去排空 run loop——见 `native/src/rfcomm.mm` 顶部。

## 已知限制

- **仅 macOS**。Windows / Linux 未实现，也**未验证**。
- **仅 ricott 型号**（米家口袋打印机 Pro）实测通过。插件里还出现过
  `mintg`/`ricotg`/`ricotp`，未测试。
- **RFCOMM 通道独占**：同时只能有一个连接。服务与 `verify-print.mjs`
  不能同时运行。
- **打印机休眠后需按一下按钮唤醒**，否则报"不可达"。
- 原生 `connect()` 是**同步**的，打印机不可达时那次请求会阻塞约 15 秒。
  这是为了规避 CFRunLoop 跨线程问题而做的取舍。

## 文档

| 文档 | 内容 |
|---|---|
| **[docs/USAGE.md](docs/USAGE.md)** | **使用指南：安装、接口参考、故障排查** |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | 帧格式、DH 握手、加密、分片 |
| [docs/REVERSE-ENGINEERING.md](docs/REVERSE-ENGINEERING.md) | 协议还原过程与证据 |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | 真机验证记录 |
| [docs/adr/](docs/adr/) | 关键决策记录 |

## 许可

MIT，见 [LICENSE](LICENSE)。协议为互操作性目的逆向所得；本项目与小米、
汉图无任何关联，详见 LICENSE 末尾的说明。
