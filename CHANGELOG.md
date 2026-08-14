# 更新日志

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- 新增 Web 查看界面截图，并补充到 README 文档
- 新增独立更新日志文件

### 优化

- 搜索栏隐藏浏览器原生清空按钮，避免输入文字后出现两个叉号
- 顶部栏固定为 64px 并与左侧头部对齐，搜索框垂直居中
- 侧栏收起后显示项目名称首字，便于快速区分不同项目

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
