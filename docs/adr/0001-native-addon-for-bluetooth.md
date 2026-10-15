# 用原生插件访问蓝牙，而非纯 JS

## Status

accepted

## Context

macOS 的蓝牙经典串口（SPP）只能通过 Objective-C 的 `IOBluetooth` 框架访问。
Node 没有 ObjC 桥，也不存在维护中的、支持蓝牙经典的纯 JS 库。

试过并**证伪**的路线：用 `serialport` 打开 macOS 为已配对设备创建的
`/dev/cu.*` 设备节点。写进去的帧字节完全正确（与已知可用的 Swift 实现逐字节一致），
但打印机**一个字节都不回复**——那个设备节点不承载本打印机的 RFCOMM 通道。

## Decision

写一个约 280 行的 ObjC++ N-API 插件（`native/src/rfcomm.mm`）包装 IOBluetooth。
这是唯一能在 Node 里访问该硬件的途径。

### 一个不直观的机制（插件里最关键的设计）

IOBluetooth 通过**委托回调**送数据，回调由**打开通道那个线程的 CFRunLoop** 派发。
Node 主线程跑 libuv 而非 CFRunLoop，因此朴素写法的插件**一个字节都收不到**——
现象与"打印机不响应"完全一样，极具误导性。

解法：用一个 5ms 的 `uv_timer` 定期执行 `CFRunLoopRunInMode(..., 0, true)`，
既不阻塞 libuv 又能排空 run loop。

## Considered Options

- **外部二进制**（曾用过 Swift）：能工作且已验证出纸，但引入第二种语言、
  需要单独编译、跨进程传数据。为"单一 Node 项目"的目标所弃。
- **FFI（koffi）直接调 IOBluetooth**：IOBluetooth 是 ObjC 消息发送，
  需要手工 `objc_msgSend`、动态创建 delegate 类、再用 C thunk 接回调。
  工作量与脆弱度都高于直接写插件。
- **纯 JS**：已证伪。

## Consequences

- 需要 `node-gyp` 与 Xcode 命令行工具才能安装。非 macOS 上加载 stub 模块，
  调用时明确报错而非崩溃。
- **原生 `connect()` 是同步的**，打印机不可达时会阻塞事件循环约 15 秒。
  刻意如此：放线程里会引入 CFRunLoop 跨线程问题。
- 通道号、委托签名等"不能顺手优化"的点写在代码注释里（见 README）。
