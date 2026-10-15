# 逆向分析报告：米家 App → 口袋打印机Pro 独立控制

## 1. 分析对象与方法

| 项 | 值 |
|---|---|
| APK | `~/Downloads/mijia.apk`（239,335,734 字节） |
| 包名 | `com.xiaomi.smarthome` |
| 版本 | `11.8.703` (versionCode `110817031`) |
| minSdk / targetSdk | 24 / 36 |
| 类总数 | 53,641 |
| 资源总数 | 12,298 |

分析工具链：REA (`rea-agents@6.4.0`) 的 Android provider（`jadx-headless-mcp 0.7.1`）
驱动 jadx 反编译。注意：REA 的 `close_binary` 清理在本机沙箱内会
`spawn EPERM` 失败并丢弃结果，因此改为直接驱动同一个 jadx MCP server 获取
同样的类/方法/资源数据。所有下列结论均来自反编译输出，未做任何推测。

## 2. 添加设备后的操作链路

用户"添加设备 → 进入设备 → 打印照片"的完整调用链（全部经反编译确认）：

```
SendPrintActivity.access$400(map, z)                       // 分享入口/设备页入口
  └─ OooOOO(): 过滤 pluginDeviceInfo.OoooOO0 == 124        // 124 = SUB_CATEGORY_ID_PRINTER
  └─ DeviceRouterFactory.getDeviceWrapper().OooO0oO(device) // 打开设备插件页（RN）
        ↓
HanntoPrinter.OooO00o(MiPrintService, PrinterInfo, PrintJobProxy)  // Android PrintService 收作业
  ├─ printJobProxy.start()
  ├─ rp4.OooOoO(rp4Var)                                   // 生成 nonce + signature
  ├─ nlf.OooOoO.execute(new a4g(...))                     // 异步：取上传 URL
  │     └─ a4g.run()
  │         ├─ GET https://api.hannto.com/v1/c/res/gen/presigned_url/
  │         │     ?file_name=…&sha1=…&model=…&uid=…&useto=print_file
  │         └─ rp4.OooO0o0(rp4, absPath, presigned_url, sha1, ch6)
  │             └─ HTTP PUT 文件到 presigned_url（200 即成功）
  │                 └─ ch6.OooO0Oo(downloadUrl, sha1, fileName)
  │                     └─ uh.run() case 13
  │                         ├─ anise → nlf.execute(new dpb(...))
  │                         └─ honey → nlf.execute(new epb(...))
  └─ dpb.run() / epb.run()
        └─ XmPluginHostApi.instance().callMethod(did, "print_job", params, cb, Parser.DEFAULT_PARSER)
              └─ PluginHostApiImpl.callMethod → request(did, method, false, …)
                  └─ doSpecRequest / callMethodFromCloud  →  MiIO 云 RPC
```

设备状态跟踪（`onStartPrinterStateTracking`）订阅的属性是 `prop.status`。

## 3. 设备型号标识（关键）

`HanntoPrinter` 中硬编码了两个型号：

| model | 用途 |
|---|---|
| `hannto.printer.anise` | 照片打印机（A4 + 4x6，含彩色） |
| `hannto.printer.honey` | **口袋打印机Pro** |

判定依据（`OooO0OO` 与 `uh.run() case 13`）：

```java
arrayList.add("hannto.printer.anise");
arrayList.add("hannto.printer.honey");
...
if ("hannto.printer.anise".equals(deviceStat.model)) { … A4 + 4x6 照片 … }
else if ("hannto.printer.honey".equals(deviceStat.model)) { … 简版 print_job … }
```

`honey` 走**简化版** `print_job`（字段少），`anise` 走**完整版**。

## 4. print_job 载荷（逐字段还原）

### 4.1 honey（口袋打印机Pro）— `epb.run()`

```json
{
  "channel": "printer_service",
  "account": "<accountId>",
  "send_time": <unix_seconds>,
  "url": "<https://cnbj2.fds.api.xiaomi.com/{bucket}/{object}?GalaxyAccessKeyId=…&Expires=…&Signature=…>",
  "file_name": "<fileName>",
  "copies": <int>
}
```

### 4.2 anise — `dpb.run()`

```json
{
  "chn": 0,
  "account": "<accountId>",
  "url": "<downloadUrl>",
  "file_type": "pdf",
  "file_name": "<fileName>",
  "sha1": "<sha1>",
  "file_size": <KB>,
  "copies": <int>,
  "color": "Color" | "Mono",
  "paper_type": "Glossy" | "Plain",
  "paper_size": "4x6" | "A4",
  "print_quality": "High" | "Normal",
  "send_time": <unix_seconds>,
  "job_type": <int>,
  "duplex": false,
  "collate": false,
  "output_order": "Reverse",
  "ps": 0,
  "rt": -1,
  "pm": 4.2
}
```

### 4.3 参数来源映射（来自 `uh.run() case 13`）

| 载荷字段 | 来源 |
|---|---|
| `color` | `PrintJobInfo.getAttributes().getColorMode() == 2 ? "Color" : "Mono"` |
| `paper_type` | `PrintDocumentInfo.getContentType() == 1 ? "Glossy" : "Plain"` |
| `paper_size` | `getAttributes().getMediaSize().getId().equals("4x6") ? "4x6" : "A4"` |
| `print_quality` | `ContentType == 1 ? "High" : "Normal"` |
| `copies` | `PrintJobInfo.getCopies()` |

### 4.4 取消打印 — `j4h.OooOo0()`

```json
{"print_job_id": [<id>]}
```
同样经 `callMethod(did, "cancel_job", …)`。

## 5. 上传腿（Hannto）

`a4g.run()` 中恢复出的完整请求：

```
GET https://api.hannto.com/v1/c/res/gen/presigned_url/
    ?file_name=<name>&sha1=<sha1>&model=<honey|anise>&uid=<accountId>&useto=print_file
Headers: API-SIGNATURE: permission
         PERMISSION-API-KEY: IxomR6MCjsO3Ared
         PERMISSION-API-NONCE: <base64(12 bytes: rand int, ts/1000, ts%1000)>
         PERMISSION-API-SIGNATURE: <base64(sha1("GET&/v1/c/res/gen/presigned_url/&IxomR6MCjsO3Ared&" + base64(sha256(nonce12 || "e9zH1USvw82YVpk7OdloAIibqKZRGrEj"))))>
         PERMISSION-CLIENT-VERSION: <versionName>
```

nonce/signature 生成算法（`rp4.OooO0Oo`，已逐条对照 smali）：

1. 12 字节 = 4B `Random.nextInt()` + 4B `(ts/1000)` + 4B `(ts%1000)`，Base64 → nonce 字符串
2. `sign = Base64(SHA256( "e9zH1USvw82YVpk7OdloAIibqKZRGrEj".getBytes("utf-8") || nonce12 ))`
3. `finalSign = Base64(SHA1("GET&/v1/c/res/gen/presigned_url/&IxomR6MCjsO3Ared&" + sign))`
4. 响应 `{"code":"0","result":{"presigned_url":…,"expiration":…}}`，随后 `PUT` 文件

上传成功后从 PUT 响应解析出 FDS 下载地址，拼成
`https://cnbj2.fds.api.xiaomi.com/{bucket}/{object}?GalaxyAccessKeyId=…&Expires=…&Signature=…`
作为 `print_job` 的 `url`。

## 6. 照片纸能力（`onStartPrinterStateTracking`）

```
MediaSize("4x6", "6寸照片", 4000, 6000)   // 默认
MediaSize.ISO_A4                          // 仅 anise，默认 true
Resolution("R2", "300x300", 300, 300)
ColorModes(3, 1)                          // COLOR | MONO
```

## 7. 独立 App 的设计结论

### 7.1 可以不依赖米家 App 的部分

`print_job` 是一次标准 **MiIO 云 RPC**，经由
`XmPluginHostApi.callMethod(did, method, params)` → `PluginHostApiImpl` →
`doSpecRequest` / `callMethodFromCloud`。它只需要：

- Xiaomi 账号会话（`userId` + `passToken` + `ssecurity`）——即米家 App 存的同一份凭证
- 设备 `did` 与 `model`

因此**不需要安装米家 App、不需要下载 RN 插件、不需要跑 React Native 运行时**。

### 7.2 仍需要云端的部分（本项目不使用）

打印 URL 必须指向 Xiaomi FDS 上打印机固件能拉取的对象，因此上传腿仍走
`api.hannto.com` 的 presigned URL + `PUT`。这一步与米家 App 共用
`api.hannto.com`，但调用方是独立进程，彼此无耦合。

### 7.3 本项目的实现

结论是：**可以完全不依赖米家 App 与云端**，直接通过蓝牙经典串口打印。

- 传输：Bluetooth Classic SPP / RFCOMM 通道 1
- 加密：DH 握手现场派生会话密钥，AES-128-ECB
- 不需要设备 token，不需要小米账号

实现见 [`src/`](../src/)，协议细节见 [PROTOCOL.md](PROTOCOL.md)。

## 8. 局限与未验证项

诚实标注未取得证据的部分：

1. **RN 插件 JS 未反编译**。设备控制页（更多操作、模板、AR 排版等）在
   `assets/*.hbc`（Hermes 字节码）与运行时下载的插件里，本报告未覆盖这些 UI 操作。
   `assets/` 下只找到 `mijia.miniplugin.spec.card.hbc`、`car.miniplugin.spec.detail.hbc`、
   `fusion.miniplugin.spec.detail.hbc`、`maml.miniplugin.spec.card.hbc`，没有打印机插件包。
2. **配网/绑定流程未分析**。添加设备本身（BLE AP 配网、扫码）不在本次范围内。
3. **未做真机打印验证**。没有打印机硬件与账号凭证，`print_job` 的实际返回未实测。
4. **`ssecurity`/`passToken` 获取方式未在 APK 内确认**，需从米家 App 已登录会话导出。
5. `hannto.printer.honey` 的 `print_job` 只有 6 个字段，未发现 honey 的纸张/彩色参数
   在 APK 中被设置——这可能是 Pro 型号固件自行决定，也可能是插件侧下发。

## 9. 真机验证进展（2026-10-14）

已对**上传腿**做了真实服务器验证（不需要打印机硬件或账号凭证）：

| 步骤 | 结果 |
| --- | --- |
| `api.hannto.com` 连通性 | ✅ 可达 |
| presign（带完整签名） | ✅ `code: 0`，返回真实 `presigned_url` |
| PUT 上传真实 JPEG | ✅ HTTP 200 |
| 下载 `download_url` 校验 | ✅ HTTP 200，SHA1 与上传内容一致 |

**签名算法（`rp4.OooO0Oo`）已被真实服务器验证正确。** 未签名请求会被拒
（`code 10002, Lack of necessary parameters: <data>`），加上 5 个签名头后即通过。

同时确认了两个 APK 之外的事实：

- presign 响应除 `presigned_url` 外还直接返回 **`download_url`**，
  与 `rp4.OooO0o0()` 自己从 PUT 响应解析出的地址一致；实现优先使用前者。
- PUT 响应的 FDS 字段名由 `it9.OooOoOO()` 确认：
  `accessKeyId` / `bucketName` / `expires` / `objectName` / `signature`。

**仍未验证**：`print_job` 这一步。它需要：

1. 米家账号会话：`userId`、`passToken`、`ssecurity`
2. 打印机 `did` 与型号确认（`hannto.printer.honey`）
3. 一台已绑定该账号的口袋打印机Pro

拿到这三项即可跑 `list` → `status` → `print` 完整链路。
