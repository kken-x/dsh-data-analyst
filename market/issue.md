### 插件地址 / Plugin link

**npm**: https://www.npmjs.com/package/dsh-data-analyst (version `0.1.0`)  
**源码**: https://github.com/kken-x/dsh-data-analyst (tag `v0.1.0`)  
**Release**: https://github.com/kken-x/dsh-data-analyst/releases/tag/v0.1.0

### 简短说明 / Summary

**Data lens / 数据透镜** 是 DeepSeek Harness 的对话式只读数据分析师。一次 `db_analyze` 调用完成：理解自然语言问题 → 生成只读 SQL → 安全执行 → 根据结果形状自动选图 → 在对话内嵌 SVG 图表 → 返回数据观察与 `queryId`。另外提供 `db_profile`（数据画像）、`db_query`（只读 SQL）、`db_visualize`（重绘/换图）三个工具。

- 支持 SQLite（Node 内置 `node:sqlite`）、PostgreSQL、MySQL。
- 三层只读防御：连接级 `readOnly`、词法级单条 SELECT 校验、执行级只读事务/Worker 超时终止。
- 默认 500 行 / 30 秒上限；密码支持 `passwordEnv` / DSH `passwordRef`；JSONL 审计不记录密码、参数值或结果数据。
- 零图表运行时依赖，手写 SVG；Client 半在 `tool.call.toolview` 注册内联图表卡片。

### 插件实际效果 / Plugin screenshots

![月度收入趋势折线图](https://raw.githubusercontent.com/kken-x/dsh-data-analyst/v0.1.0/docs/preview-line.png)

![收入构成环形图](https://raw.githubusercontent.com/kken-x/dsh-data-analyst/v0.1.0/docs/preview-donut.png)

两张图都是插件实际执行的 SQL 结果渲染（示例库 `examples/demo.sqlite`，576 行销售数据）。

### 补充信息 / Additional details

- 包名：`dsh-data-analyst`，版本 `0.1.0`，许可证 MIT。
- 兼容范围：DSH `>=0.2.0-rc.1 <0.3.0-0`；Node `>=22.19`。
- 已验证环境：DSH `0.2.2-rc.1`，Windows 11，Node `22.20.0`。
- 验证：`npm test` 20/20；实际模型生成 SQL、SQLite 执行、自动选图、图表 HTTP 路由 `200 image/svg+xml`、Client toolview 注册均通过；危险 SQL（多语句 / DELETE / 锁定读）被拒绝。
- 安装：`dsh plugin --profile <profile> add dsh-data-analyst`
- npm 包已公开；可通过 `npm view dsh-data-analyst version` 验证。

感谢审核！
