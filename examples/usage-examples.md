# 使用示例

## 1. 首次分析项目

让 AI 助手分析你的项目，它会自动调用 `analyze_project` 创建知识库：

```
请帮我分析一下这个项目的整体业务逻辑
```

AI 会生成业务总结并通过 MCP 持久化保存。

## 2. 深入分析具体问题

当你提出更具体的问题时，AI 会自动调用 `record_insight` 记录分析结果：

```
这个项目是如何处理用户认证流程的？
```

```
项目中的消息推送功能是怎么实现的？
```

`record_insight` 支持丰富的关联信息：
- `relatedFiles` — 相关文件路径（系统自动为这些文件生成快照）
- `relatedSymbols` — 关联的函数名、类名、变量名
- `relatedModules` — 关联的业务模块名
- `relatedApis` — 关联的 API 路径

## 3. 复用历史分析

下次提问时，AI 会先通过 `search_insights` 检索已有洞察，避免重复分析：

```
之前分析过的认证流程，能再详细说明一下 token 刷新机制吗？
```

## 4. 检查知识新鲜度

当代码发生变更后，可以检查历史知识是否仍然可信：

```
帮我检查一下"认证流程"相关的知识，看看代码有没有变
```

→ AI 调用 `check_knowledge_freshness`，返回文件变化报告

```
📊 检查结果: stale
📁 变化文件:
  - src/auth/token.js: content_changed
📁 未变化文件:
  - src/auth/index.js
```

## 5. 分析影响范围

修改代码前，分析影响范围和风险：

```
修改 src/store/unit.js 会影响哪些文件和页面？
```

→ AI 调用 `analyze_impact`，返回：

```
🎯 影响分析: unit.js
🟠 风险等级: HIGH (62/100)
📍 直接影响: 12 个文件
📍 间接影响: 8 个文件
💡 相关知识: 6 条（2 条已过期）
```

## 6. 完整上下文查询

对于复杂问题，可以一次性获取所有相关信息：

```
帮我看看单位权限这块，现在是什么逻辑？代码有没有变？如果改的话影响大不大？
```

→ AI 调用 `get_full_context`，一次性返回：
- 知识搜索结果 + 每条知识的新鲜度
- 目标文件的影响范围分析
- 建议的后续操作

## 7. 批量刷新项目知识

定期检查项目所有知识的有效性：

```
帮我扫描一下这个项目的所有知识，看看有多少已经过期了
```

→ AI 调用 `refresh_project_knowledge`，返回统计报告：

```
📊 项目知识刷新报告
  总计: 35 条
  🟢 有效: 26 条
  🔴 需验证: 7 条
  ⚪ 无快照: 2 条
```

## 8. 查看项目概览

```
帮我看看这个项目目前积累了哪些分析成果
```

## 9. MCP 配置示例

### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "project-analysis": {
      "command": "npx",
      "args": [
        "tsx",
        "/absolute/path/to/project-analysis-mcp/src/index.ts"
      ]
    }
  }
}
```

### Cursor

在 `.cursor/mcp.json` 中添加：

```json
{
  "mcpServers": {
    "project-analysis": {
      "command": "npx",
      "args": [
        "tsx",
        "/absolute/path/to/project-analysis-mcp/src/index.ts"
      ]
    }
  }
}
```

### Codex

在设置中添加 MCP Server，命令为：

```
npx tsx /absolute/path/to/project-analysis-mcp/src/index.ts
```

> 请将路径替换为你的实际安装路径。
