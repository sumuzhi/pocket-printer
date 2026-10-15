# 改用 NestJS 官方机制，替换掉手写实现

## Status

accepted

## Context

初版 NestJS 迁移虽然能跑，但里面有几处是自己手写的、与框架约定不符的做法。
这不是风格问题——手写实现绕开了框架已有的保证，且容易在后续维护中出错：

| 项目 | 手写做法 | 问题 |
|---|---|---|
| 请求体 | `bodyParser: false` + `req.on('data')` 手读流 + 手动限长 | 违背文档约定；限长、超时、异常都要自己处理 |
| 异常映射 | 控制器里 `try/catch` + `BadRequestException` | 状态码散落在各处，领域层被 HTTP 概念污染 |
| SSE | `interval(1000)` 轮询任务表 | 每个订阅者每秒一次空转；状态变化最多延迟 1 秒 |
| 配置 | 自建 `version.ts` + 散落的 `process.env` | 配置项不可枚举，没有默认值集中处 |
| 测试应用 | `Test.createTestingModule().createNestApplication()` | **与生产的 bootstrap 配置不同**（见下） |

## Decision

改为框架的官方机制：

1. **原始请求体** → `NestFactory.create(AppModule, { rawBody: true })`
   + `app.useBodyParser('raw', { type: () => true, limit })`
   + `@Req() req: RawBodyRequest<Request>` 读 `req.rawBody`。
   限长由 `express.raw` 处理，超限自动 413。

2. **领域错误 + 全局过滤器** → `src/common/errors.ts` 定义
   `BadInputError` / `PayloadTooLargeError` / `ConflictError` / `PrinterUnavailableError`；
   `DomainExceptionFilter` 统一映射为 HTTP。**服务层不再 import `@nestjs/common`**。

3. **事件驱动 SSE** → `PrinterService` 用 `Subject` 发布每次状态变化，
   SSE 端点 `merge(of(当前状态), watch())` 并 `takeWhile(非终态)`。
   不再轮询。

4. **`ConfigModule`** → `src/config/configuration.ts` 导出工厂函数，
   所有配置项集中且有默认值；`ConfigService` 注入使用。

5. **共享 bootstrap** → `src/bootstrap.ts` 的 `createApplication()` 同时被
   `main.ts` 与测试使用。

## 为什么第 5 点最重要

改测试时发现：**7 个暂存测试全部失败**，原因不是被测代码有问题，而是
**测试应用与生产应用的配置不同**——测试用的 `createNestApplication()` 没有注册
`raw` body parser，于是 `req.rawBody` 是 `undefined`。

这暴露了一个比"风格不符"更严重的风险：**测试可能因为配置差异而通过或失败，
却不反映生产行为**。把 bootstrap 抽成共享函数后，两者必然一致。

## Considered Options

- **保留手写实现**：能工作，但每次修改都要重新验证手写部分的边界行为
  （限长、背压、异常），而这些框架已经处理并测试过。
- **不抽共享 bootstrap，测试里复制配置**：短期省事，但两份配置必然漂移，
  上面那 7 个失败就是漂移的预演。

## Consequences

- `src/bootstrap.ts` 成为应用装配的唯一位置；`main.ts` 只负责解析 CLI 参数
  并映射到环境变量，然后调用它。
- 服务层不依赖 HTTP 概念，可以脱离 Nest 单独测试（`protocol.ts` 本来就如此）。
- 新增配置项只需改 `configuration.ts` 一处。
- 异常状态码集中在 `DomainExceptionFilter`，可整体审查。
