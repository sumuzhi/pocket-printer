# 打印协议

本文档描述与打印机通信所需的全部协议细节，由米家 App 官方 APK 的插件
（`com.xiaomi.smarthome` 11.8.703）逆向分析所得。

实现见 [`src/protocol.ts`](../src/protocol.ts)（纯函数，无 I/O）与
[`src/session.ts`](../src/session.ts)（会话流程）。

## 传输层

**Bluetooth Classic SPP（RFCOMM）**，不是 BLE。

| 项 | 值 |
|---|---|
| 协议 | 蓝牙经典串口（SPP） |
| RFCOMM 通道 | **1**（硬编码，见下） |
| UUID | `00001101-0000-1000-8000-00805f9b34fb` |
| MTU | 650（实测） |

### 通道号必须是 1

打印机的 SDP 记录里，SPP UUID（`0x1101`）指向**通道 22**，但：

- 通道 22 → 连接失败（`0xe00002bc`）
- 通道 **1** → 成功（MTU 650）

**不要**改成通过 `0x1101` 自动发现通道——那会拿到 22 并失败。
通道 1 是硬编码的。

## 帧格式

每帧 = 22 字节头 + 加密载荷 + 2 字节尾部。

| 偏移 | 长度 | 字段 | 说明 |
|---|---|---|---|
| 0 | 1 | `FRAME` | 固定 `0x7E` |
| 1 | 1 | `VERSION` | 固定 `100` |
| 2 | 1 | — | 固定 `0` |
| 3 | 1 | 通道 | 见下表 |
| 4 | 1 | 交互类型 | 见下表 |
| 5 | 1 | 编码 | `2`=HEX，`3`=JSON |
| 6 | 4 | 序号 | uint32 小端 |
| 10 | 4 | 序号（重复） | 与 6 相同，插件如此 |
| 14 | 2 | total | uint16 小端 |
| 16 | 2 | current | uint16 小端 |
| 18 | 2 | attributes | `body.length + 5120`，分片时再 `+8192` |
| 20 | n | 载荷 | 加密后的数据 |
| n-2 | 1 | 校验和 | `(所有字节之和 - 126) & 0xFF`，计算时该字节与末字节按 0 计 |
| n-1 | 1 | `0x7E` | 帧尾 |

### 通道

| 值 | 名称 | 用途 |
|---|---|---|
| `255` | AUTH | 握手 |
| `3` | DATA | JSON 命令 |
| `4` | FILE | 文件数据 |

### 交互类型

| 值 | 名称 |
|---|---|
| `6` | REQUEST（客户端请求） |
| `16` | CLIENT_HELLO_DH |
| `17` | SERVER_HELLO_DH |
| `18` | CLIENT_CONFIRM_DH |
| `19` | SERVER_CONFIRM_DH |

### 编码

| 值 | 名称 |
|---|---|
| `2` | ENCODING_HEX |
| `3` | ENCODING_JSON |

> **注意**：`ENCODING_JSON` 是 **3**，不是 1。用错会导致命令发出后完全无响应
> ——现象与"打印机不工作"一模一样。

## DH 握手

会话密钥由 DH 现场派生，**不需要设备 token**。

### 流程

```
客户端 → CLIENT_HELLO_DH   (通道 255, 类型 16, JSON, body = "hello")
打印机 → SERVER_HELLO_DH   (通道 255, 类型 17)  58 字节
客户端 → CLIENT_CONFIRM_DH (通道 255, 类型 18)  32 字节
打印机 → SERVER_CONFIRM_DH (通道 255, 类型 19)  body = "ok" 或 "nok"
```

### SERVER_HELLO_DH 的载荷

36 字节，**G / P / RA 都是 ASCII 十六进制文本**，不是二进制整数：

| 偏移 | 长度 | 字段 |
|---|---|---|
| 0 | 4 | G（ASCII hex） |
| 4 | 16 | P（ASCII hex） |
| 20 | 16 | RA（ASCII hex） |

实测样例：

```
g = 2
p = E6969D3D495BE32C
ra = 8F237C4A85B8A178（每次不同）
```

> 把 G/P/RA 当二进制解析会得到一个"看起来合理"但错误的大整数，
> 打印机回 `nok`。

### 客户端计算

```
私钥 bp      = 随机数，2 ≤ bp < p-1
客户端公钥 rb = g^bp mod p
共享密钥 k    = ra^bp mod p
```

### 两处补位规则（极易搞反）

| 值 | 补位方式 |
|---|---|
| `rb`（发给打印机的公钥） | 十六进制文本，**前面补 `'0'`（0x30）** 到 16 字节 |
| `k`（会话密钥） | 十六进制文本，**末尾补 `0x00`** 到 16 字节 |

**两者互为镜像，搞反会导致握手返回 `nok`。**

### CLIENT_CONFIRM_DH 的载荷

32 字节：

```
[ rb 文本（16 字节，前补 '0'） | AES(key, P 原始字节) 的前 16 字节 ]
```

注意第二部分加密的是**帧里收到的 P 的原始 ASCII 字节**（即 `body[4..20]`），
而不是把 P 重新渲染成十六进制。重渲染可能长度不同，打印机校验的是字节序列。

### 会话密钥

`key` = 上述 16 字节，用作 **AES-128-ECB** 密钥。

## 加密

**AES-128-ECB，无填充。**

调用方需自行补零到 16 字节边界（协议不做 PKCS#7 填充）。
响应解密后需**去掉末尾的 `0x00`** 才能得到 JSON。

## JSON 命令

握手完成后，通过通道 3 发送：

```json
{"method": "mixed_status", "id": 1, "params": {}}
```

载荷经 `AES-ECB(key, zeropad(json))` 加密，编码标为 `3`（JSON）。

### 支持的方法

| 方法 | 参数 | 用途 |
|---|---|---|
| `mixed_status` | `{}` | 状态、电量 |
| `get_prop` | `["device_info"]` | 设备信息（型号/固件/SN/MAC） |
| `get_prop` | `["status"]` | 状态（同 mixed_status） |
| `print_job` | `{file_size, copies, job_type, channel}` | 创建打印任务 |
| `job_info` | `[job_id]` | 查询任务状态 |
| `cancel_job` | — | 取消任务 |
| `clean` / `clean_data` | — | 清洁 |
| `confirm_job` | — | 确认 |
| `resume_printer` | — | 恢复 |

> `get_prop` 只接受**字符串属性名**。数字形式的 siid/piid（如 `[5, 56]`）
> 通过蓝牙返回空对象——即使对已知有效的属性也一样。

### 严格一问一答

协议**不支持并发命令**。两条命令同时在途时，两个等待者会争抢同一条回复，
其中一个报"无响应"——而打印机是好的。

**必须串行发送命令**，等待上一条的回复后再发下一条。

## 打印流程

```
1. mixed_status            → 确认打印机 idle
2. print_job               → 得到 job_id
3. sendFile（分片传输）
4. 轮询 job_info 直到 job_state == "finished"
```

### print_job 参数

```json
{
  "file_size": 501005,
  "copies": 1,
  "job_type": 0,
  "channel": 576
}
```

`job_type` 取值（插件常量）：

| 值 | 含义 | 值 | 含义 |
|---|---|---|---|
| `0` | 照片 | `9` | AR |
| `1` | 证件照（裁切） | `10` | 留声照片 |
| `2` | 证件照 | `11` | 拼图 |
| `3` | 文档 | `12` | 拆分 |
| `4` | 服务 | `13` | 大头贴 |
| `5`-`8` | 微信相关 | `14` | 标签 |
| | | `15` | 卡片 |
| | | `100` | 固件升级 |

### 文件分片

| 常量 | 值 | 含义 |
|---|---|---|
| `BODY_LEN` | **988** | 每帧承载的文件字节数 |
| `BATCH` | **3** | 每 3 帧合并成一次写入 |
| `SEGMENT_FRAMES` | **1061** | 每个传输段最多帧数 |

每帧的载荷构造：

```
[ jobId（4 字节小端） | 文件数据（≤988 字节） ]  → AES 加密 → 帧体
```

因此每帧实际发出的字节数：

```
明文  = 4 + 988 = 992
补零  = 992（正好是 16 的倍数）
帧总长 = 22 + 992 = 1014
```

**为什么分批**：508 帧逐个写 = 508 次蓝牙系统调用；每 3 帧合并后只需 170 次。
实测速率约 117 KB/s。

### 实例

501,005 字节的成片：

```
帧数   = ceil(501005 / 988) = 508
写入次数 = ceil(508 / 3)    = 170
实际发出 = 508 × 1014       = 515,112 字节（膨胀 3%）
传输耗时 ≈ 4.3 秒
```

### 任务状态

| 状态 | 含义 |
|---|---|
| `downloading` | 正在接收文件 |
| `printing` | 正在打印（热升华约 70 秒） |
| `finished` | 完成 |

## 设备信息

`get_prop ["device_info"]` 返回：

```json
{
  "fw_ver": "2.1.2_0041",
  "hw_ver": "REVA",
  "sn_all": "...",
  "sku": "BHR081PCN",
  "model": "xiaomi.printer.ricott",
  "mac": "F0:13:C1:XX:XX:XX",
  "did": "...",
  "time_left": 532266,
  "bt-phone-mac": "..."
}
```

固件版本号 `_0041` 中的 `41 ≥ 3`，表示支持加密（走 ECB 路径）。

## 未使用但需了解的部分

### BLE 通道（`ENCRYPT_MIJIA`）

插件里有另一条加密路径，使用 `securityLock.encryptMessageWithToken()`，
需要**设备 token**。该 token 由云端 RPC 下发：

```
方法: getDevicePropFromServer
端点: api.io.mi.com/miotspec/prop/get
属性: siid=5（PRINTER）, piid=56（HANDSHAKE_TOKEN）
```

**本项目不使用这条路径**，因此不需要 token、不需要小米账号、不需要 BLE。
通过蓝牙读 `get_prop [5, 56]` 返回空，因为设备本身不提供该属性。

### 设备 token 与 MAC 的位置

- `mac`：`get_prop ["device_info"]` 的返回字段，可直接读取
- `token`：仅云端提供，见上

## 参考

- 逆向过程与证据：[REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md)
- 真机验证记录：[VERIFICATION.md](VERIFICATION.md)
