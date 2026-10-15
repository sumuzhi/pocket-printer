# 真机验证

本项目**不需要**小米账号、设备 token 或云端 API。以下验证全部只依赖蓝牙。

## 验证项目

| # | 项目 | 是否耗纸 | 说明 |
|---|---|---|---|
| 1 | 握手 + 状态读取 | ❌ | 确认打印机可达、电量、固件 |
| 2 | 设备信息读取 | ❌ | 型号、SN、MAC |
| 3 | 打印一张 | ✅ **消耗 1 张相纸** | 完整链路：分片传输 + 打印 |

## 1 & 2：只读验证

```bash
npm start
curl http://127.0.0.1:8000/api/printer/status
```

期望输出包含：

```
可达: true | 握手: true | 电量: NN% | 固件: 2.1.2_0041 | 状态: idle
```

失败时的常见原因：

| 现象 | 原因 |
|---|---|
| 找不到任何蓝牙设备 | 打印机未配对，或未开机 |
| 无法打开打印通道 | 另一个进程占用（RFCOMM 独占） |
| 打印机不可达 | 休眠，按一下按钮唤醒 |
| 握手被拒绝（`nok`） | DH 两处补位规则搞反 |

## 3：打印验证

**会消耗一张相纸。**

```bash
node verify-print.mjs <1200x1800.jpg>
```

期望输出：

```
✅ 握手成功 (MTU 650)
打印前: idle | 电量 NN%
✅ print_job 已创建: job_id=NN
✅ 传输完成，耗时 4.3s
   [downloading] → [printing] ×14 → [finished]
🎉 打印完成: job=NN  出纸 1 张
```

---

#### 验证结果

**任务 71 打印成功并出纸。**

```
待打印: /tmp/pp/verify-print.jpg
  501005 字节 (489.3KB), 508 帧
  JPEG 头: ffd8
✅ 握手成功 (MTU 650)
打印前: idle | 电量 94%
✅ print_job 已创建: job_id=71
✅ 传输完成，耗时 4.3s
   [downloading] 传输 4294ms
   [printing]    ×16
   [finished]    传输 4294ms 打印 83823ms
🎉 打印完成: job=71  出纸 1 张  打印耗时 83823ms
```

## 验证结果

### 与 Swift 实现对照

同一张成片（501005 字节，完整留白版式）：

| 项目 | Node (job 71) | Swift (job 66/67) |
|---|---|---|
| 设备型号 | ricott | ricott |
| 固件 | 2.1.2_0041 | 2.1.2_0041 |
| MTU | 650 | 650 |
| 成片 | 1200×1800 | 1200×1800 |
| 文件大小 | 501005 B | 501005 B |
| **帧数** | **508** | **508** |
| 传输耗时 | 4294 ms | 4140 ms |
| 打印耗时 | 83823 ms | 69536 ms |
| job_state | finished | finished |
| 出纸 | 1 张 | 1 张 |

帧数与任务状态完全一致；打印耗时的差异属正常波动（热升华打印头温度与电量影响，
两次测试电量分别为 94% 与 62%）。

### 协议层的离线对比

除真机验证外，协议层还与 Swift 实现做了**逐字节对比**，5 个用例全部一致：

| 用例 | 内容 | 结果 |
|---|---|---|
| CASE1 | 握手帧（27 字节） | ✅ 完全一致 |
| CASE2 | AES-128-ECB 单块 | ✅ |
| CASE3 | 加密文件帧（1014 字节，含 988 字节正文） | ✅ |
| CASE4 | zpad 补位边界（17 字节） | ✅ |
| CASE5 | DH confirm 的 proof 部分 | ✅ |

### 实物确认

**用户确认打印出的照片正常。**

这一点单独记录，因为它的强度高于任务状态：`job_state: finished` 只说明打印机
认为任务完成，而实物确认说明**送进打印机的字节确实是预期的那张图**——
它同时验证了 1200×1800 成片的正确性、以及协议栈的帧编码与加密。
之前的 job 66/67 只有任务状态，这次两者都有。

### 复现方式

```bash
cd server
node verify-print.mjs <image.jpg>    # 消耗一张相纸
```

此脚本保留在仓库中，协议若有改动可重复验证。

# 附：无 token / 无账号的验证

### 要验证的命题

**打印不需要设备 token，也不需要小米账号。**

这曾是一个误解：token 被当成"必须导出的设备密钥"。分析 APK 后确认，
它只服务于另一条加密路径（见下），与蓝牙经典打印无关。

### 两条加密路径

插件里有两种加密方式，用途完全不同：

| 路径 | 加密 | 是否需要 token |
|---|---|---|
| **蓝牙经典打印** | `ENCRYPT_ECB`：DH 握手派生会话密钥 | ❌ **不需要** |
| BLE 通道 | `ENCRYPT_MIJIA`：`securityLock.encryptMessageWithToken()` | ✅ 需要 |

判定依据（插件源码）：

```js
if (encryptType == ENCRYPT_MIJIA) {
    // 只有这个分支用 token
    _miot.Device.getBluetoothLE().securityLock.encryptMessageWithToken(...)
}
```

而打印走的是 `ENCRYPT_ECB`——`setEncryptType(ENCRYPT_ECB)` 后 `sayHello()`，
会话密钥由 DH 握手现场派生。

### token 的真实来源

即使 BLE 那条路需要它，获取方式也不是"从账号导出"，而是**云端 RPC**：

```js
// 插件 getDeviceToken()
var param = { did: ..., siid: 5, piid: 56 };   // PRINTER / HANDSHAKE_TOKEN
_miot.Service.spec.getPropertiesValue([param], DATA_SOURCE.RPC)
  .then(res => hexCharCodeToStr(res[0].value.replace(/\s*/g, "")))
```

APK 侧的决定性证据：

```
方法名:  getDevicePropFromServer     ← "FromServer"
云端点:  /miotspec/prop/get
         api.io.mi.com
```

真机实测也印证了这一点：通过蓝牙 `get_prop [5, 56]` 返回空——**设备本身不提供
这个属性**，它由云端下发（绑定信息存在账号下）。

**结论：token 需要登录米家账号 + 云端 RPC 才能拿到。但打印不需要它。**

### 验证环境（凭证全部为零）

| 项 | 状态 |
|---|---|
| 代码中 `token` | **0 个文件** |
| 账号环境变量 | **0 个** |
| 凭证文件 | **无**（`/tmp/mijia_creds.json` 已删除） |
| 硬编码 MAC | **0 个文件**（改为自动发现） |

#### 验证结果

**任务 72 打印成功并出纸。**

```
待打印: 501005 字节 (489.3KB), 508 帧
✅ 握手成功 (MTU 650)          ← DH 握手，无 token
打印前: idle | 电量 89%
✅ print_job 已创建: job_id=72
✅ 传输完成，耗时 4.3s
   [downloading] → [printing] ×14 → [finished] 70453ms
🎉 打印完成: job=72  出纸 1 张  打印耗时 70453ms
```

设备地址由**自动发现**得到，全程无人工配置、无 token、无账号。

### 顺带修掉的两个自身缺陷

**1. 并发命令竞态**（本轮引入）

`/api/printer/status` 曾用 `Promise.all([status(), deviceInfo()])`。
但协议是**严格一问一答**：两条命令同时在途时，两个等待者争抢同一条回复，
其中一个报"无响应"——**打印机明明是好的**。

现象是错误信息从「未收到 SERVER_HELLO_DH」变成「命令 mixed_status 无响应」，
这提示握手已成功、问题在后续并发。改为串行后立即正常。

**2. 自动发现的双重连接**（本轮引入）

最初的发现流程是「探测连接 → 关闭 → 重连」，结果握手失败。
隔离测试显示直接连接 860ms 就成功——打印机需要时间从第一次通道恢复。
改为**复用探测时建立的连接**后正常。

这个缺陷只在走发现流程时出现，而发现流程正是用户的默认路径。

### 独占性说明

RFCOMM 通道是**独占的**：送印服务与 `verify-print.mjs` 不能同时连接打印机。
两者同时运行时，后启动的一方会报"无法打开打印通道"。错误提示已说明这一点。
