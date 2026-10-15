# 迁移到 NestJS，并把打印改为异步任务

## Status

accepted

## Context

项目原本是一个极简的 Node 服务：Node 内置 `http`、7 个端点、**无构建步骤**
（依赖 Node 的类型擦除直接运行 TypeScript）、运行时依赖只有 `node-native-api`。

有两个推动重构的理由：

1. **打印阻塞 HTTP 请求约 75 秒**（4 秒传输 + 70 秒打印）。
   `POST /api/print` 一直挂着直到任务结束。客户端会超时，也无法展示进度。
2. 端点逻辑、暂存状态、打印流程混在一个文件里，随着功能增长会越来越难维护。

## Decision

**迁移到 NestJS**，并把打印改成异步任务模型。

### 异步打印

```
POST /api/print            → 202 Accepted + { id, state: "queued" }   立即返回
GET  /api/print/:id        → 当前状态与进度
GET  /api/print/:id/events → SSE 推送状态变化
GET  /api/print            → 最近任务列表
```

任务状态：`queued → transferring → printing → finished | failed`

进度由打印机的计数器驱动，而不是估算。

### 串行命令队列

`PrinterService` 独占持有一台打印机，所有访问经由一条 Promise 链串行化。

这解决了一个具体的既有 bug：协议是**严格一问一答**，而旧实现中
`GET /api/printer/status` 用 `Promise.all` 并发发了两条命令，两个等待者争抢同一条
回复，其中一个报"无响应"——打印机明明是好的。

任务**排队而非拒绝**：打印期间发起的状态探测会等待轮次，而不是失败。

## Considered Options

- **保持无框架**：保留零构建、单依赖的优点。但需要自己实现任务状态机与并发控制，
  而这些正是框架的 DI 与生命周期能帮忙的地方。
- **Express + 手写路由**：比 Nest 轻，但同样要手写任务管理，且缺少 DI 带来的可测试性。
- **Next.js**：这是前端框架，与本项目的服务端定位不符（曾一度混淆）。

## Consequences

- **引入构建步骤**：NestJS 依赖装饰器与 `emitDecoratorMetadata`，而 Node 的类型擦除
  做不到（实测带装饰器的 `.ts` 直接运行会报错）。因此必须 `npm run build` 后再运行。
  这放弃了原先把"无需构建"当作卖点的设计。
- **运行时依赖从 1 个增加到 7 个**（@nestjs/core、common、platform-express、
  reflect-metadata、rxjs 等）。
- **未使用 `@nestjs/cli`**：它的 `@nestjs/schematics` 要求 TypeScript ≥6，而项目用
  5.9。由于文件都是手写的，不需要脚手架，改用 `tsc` 直接构建，避免了强制升级 TS。
- `src/printer/protocol.ts` 与 `session.ts` **未改动**——协议层是纯函数，
  迁移不涉及它，54 项协议测试原样保留。
- 暂存与打印仍然分离，且**没有任何测试会消耗相纸**（详见 AGENTS.md）。

## 迁移中发现并修掉的三个缺陷

1. **body parser 吃掉请求流**：NestJS 默认启用 `json()` / `urlencoded()`，
   它们会消费请求流；而 `POST /api/staged` 需要自己从流里读原始字节，
   结果永远等不到数据、**请求挂起**。由于本项目没有任何端点需要解析后的请求体，
   全局关闭 body parser。

2. **发现流程没有时间预算**：每台候选设备最长阻塞 15 秒，3 台就是 45 秒以上；
   打印机休眠时状态探测超过 90 秒仍未返回，超出客户端等待。加入 20 秒总预算。

3. **超大上传直接断连**：早期实现用 `req.destroy()` 中止超限请求，
   客户端只看到 "socket hang up"，不知道原因。改为 `req.pause()` 并返回 **413**
   与明确说明。

这三处都不是框架造成的，而是迁移过程中暴露出来的既有设计问题。
