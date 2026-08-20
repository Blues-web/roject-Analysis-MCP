# 更新日志

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- 新增 `/ai.html` AI 操作层 Web UI
- Web UI 支持自然语言对话、项目选择、会话历史、Tool/Workflow 过程展示、参数展示、用户确认、结果表格和执行历史
- Web 服务新增 LLM 配置、Agent 对话、会话和日志 API
- Capability/Tool/Workflow/Permission 增加 `confidence: high | medium | low`
- Tool 增加 `sourceFiles`、`sourceApis`、`sourcePages`、`sourceMethods` 溯源字段
- Workflow 增加 `confidence`、`sourceTools`、`sourcePages` 来源信息
- 新增统一 `LLMProvider`，支持 OpenAI 和 OpenAI Compatible API
- 新增 `configure_llm_provider`、`get_llm_config`、`agent_chat`、Agent 会话和日志工具
- Agent Runtime 支持意图理解、Tool/Workflow 选择、参数校验、权限检查、确认、多轮对话和连续执行
- Tool 执行器通过 Tool API Mapping 调用原系统 API，不复制业务规则
- 新增 `generate_project_workflows`、`list_registered_workflows`、`get_registered_workflow`、`get_workflow_registry`
- 新增 Workflow Generator，自动组合 Tool 生成业务 Workflow
- Workflow 支持条件分支、参数传递、用户确认、暂停等待输入、继续执行和失败策略
- Workflow Registry 独立持久化，支持版本保留和增量注册
- 新增 `generate_project_tools`、`list_registered_tools`、`get_registered_tool`、`get_tool_registry`
- 新增 Business Capability → Tool Generator，生成业务语义 Tool
- Tool Registry 独立持久化，支持版本保留和增量注册
- 新增 `analyze_project_static` 自动静态分析工具
- 新增 `get_project_analysis` 结构化知识读取工具
- 新增 Project Analyzer 模块，支持页面、API、权限、状态、业务能力和工作流识别
- Project Knowledge 支持增量合并，避免重新生成全部数据
- 新增 Web 查看界面截图，并补充到 README 文档
- 新增独立更新日志文件

### 优化

- 搜索栏隐藏浏览器原生清空按钮，避免输入文字后出现两个叉号
- 顶部栏固定为 64px 并与左侧头部对齐，搜索框垂直居中
- 侧栏收起后显示项目名称首字，便于快速区分不同项目

### 测试

- 新增 Project Analyzer 测试 2 项、Tool Generator / Registry 测试 2 项、Workflow Generator 测试 2 项、Agent Runtime 测试 3 项，测试总数增加到 81 项

## [5.1.0] - 2026-08-14

### 修复

- 修复相关文件路径归一化、路径穿越防护、快照一致性和原子写入等健壮性问题
- 修复 stale 风险权重无限增长问题
- 新增批量新鲜度更新与文件缓存，提升检查性能

### 测试

- 新增 15 项回归测试，测试总数增加到 72 项

## [5.0.0]

### 新增

- 新增 `analyze_impact` 工具
- 新增 `get_full_context` 整合工具
- 实现依赖图构建和 BFS 遍历
- 实现风险评分算法
- 集成 P0-1 和 P0-2，形成完整闭环

## [4.0.0]

### 新增

- 新增 `check_knowledge_freshness` 工具
- 新增 `refresh_project_knowledge` 工具
- 实现文件快照和新鲜度检查
- `search_insights` 支持 `checkFreshness` 参数

## [3.0.0]

### 新增

- Insight 新增 `relatedSymbols`、`relatedModules`、`relatedApis`、`fileSnapshots`、`status`、`lastVerifiedAt`、`version` 字段
- 实现文件快照生成（mtime/size/hash）
- 实现 Schema 版本自动迁移
- 旧数据兼容

## [1.0.0]

### 新增

- 基础项目分析功能
- Insight 记录和搜索
- JSON 持久化
