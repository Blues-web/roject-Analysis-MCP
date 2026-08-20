# project-analysis-mcp 总控提示词

本文件是 `project-analysis-mcp` 的总控上下文。后续所有开发、重构、排查、测试和新增能力，都必须先以本文件为总纲，再结合当前代码结构实施。

## 产品目标

把传统 Web 项目自动转换成 AI 可操作应用。

输入：

- 一个完整 Web 项目
- 一个用户配置的 LLM API Key

输出：

- 自动生成的 AI 操作层

## 核心链路

```text
Project
 ↓
Analyze
 ↓
Project Knowledge
 ↓
Business Capability
 ↓
Tool
 ↓
Workflow
 ↓
Tool Registry
 ↓
Agent
 ↓
Conversation
 ↓
Tool Execution
 ↓
Original Web API
```

## 核心原则

1. 不推翻原 Web 系统
2. 不重写原有业务逻辑
3. 不让 AI 直接操作数据库
4. 不让 AI 绕过原系统权限
5. Tool 必须映射真实业务能力
6. Tool 必须可以追溯到源代码
7. AI 自动生成，但必须支持人工审核
8. 高风险操作必须确认
9. 支持多 Tool 编排
10. 支持 Workflow
11. 支持多轮对话
12. 支持 OpenAI Compatible API
13. 支持项目知识持续更新
14. 支持 Tool Registry
15. 支持执行日志和审计

## 最终产品形态

```text
┌──────────────────────────────────┐
│          AI 操作层                │
│                                  │
│  “帮我创建明天的巡检计划并提交审批” │
│                                  │
│       ↓ Agent                    │
│       ↓ Workflow                 │
│       ↓ Tool                     │
│       ↓ 原系统 API               │
│                                  │
│  创建成功                         │
└──────────────────────────────────┘
```

目标：让一个原本需要用户学习菜单、页面、按钮和业务流程的 Web 系统，通过自动代码分析和 Tool 生成，逐步变成“用户只需要告诉 AI 想完成什么事情，AI 自动完成操作”。

## 开发优先级

```text
正确性 > 自动化程度 > UI 美观
```

## 不可妥协的约束

- 对于无法从代码确定的业务逻辑，不允许编造。
- 所有自动生成结果必须支持：
  - 查看来源
  - 查看推理依据
  - 人工修改
  - 重新生成
  - 启用 / 禁用
  - 版本管理
- Tool 必须使用业务语义命名，例如 `create_plan`，不能使用 `handleCreate`、`createPlan`、`postPlanCreate` 这类代码命名。
- Tool 必须保留：
  - `sourceFiles`
  - `sourceApis`
  - `sourcePages`
  - `sourceMethods`
  - `confidence`
- Workflow 必须由原子 Tool 组合而成，不能把执行代码写死进 Workflow。
- Agent 只负责意图理解、参数提取、Tool/Workflow 选择、流程编排；真正执行必须调用原系统 API。

## 当前实现基线

当前仓库已经实现：

- Project Analyzer：自动分析项目结构、页面、API、Store、权限、实体、状态和能力
- Tool Generator / Tool Registry：业务语义 Tool 生成与持久化
- Workflow Generator / Workflow Registry：Tool 组合流程生成与持久化
- Agent Runtime：OpenAI Compatible LLM Provider、多轮对话、Tool Call、确认、执行和日志
- AI 操作层 Web UI：`/ai.html`，支持自然语言对话、Tool 过程、参数、确认、结果和执行历史

后续开发应继续在现有模块上演进，不推翻当前代码结构。

## 开发约定

- 修改前先阅读相关模块和测试。
- 新增能力必须补充测试。
- 保持现有 MCP Tool 和 Web API 兼容。
- 数据写入必须考虑原子性、路径安全和增量合并。
- 不主动修改用户真实项目文件。
- 涉及高风险或破坏性操作时，先确认再执行。
