# 真实使用记录

本文档记录了 `project-analysis-mcp` 在两个实际项目中的使用过程，展示知识的积累和复用。

## 项目一：分级管控

### 项目概况

- **项目名称**：分级管控
- **项目路径**：`/Users/qujinpeng/hzwq/project/分支/分级管控`
- **技术栈**：Vue 2 + Element UI + Webpack + Vuex + 思极地图 SDK
- **业务领域**：电力行业全业务工单可视化

### 业务总结

分级管控是一个电力行业的全业务工单可视化项目，包含 work（全业务工单可视化）和 site（现场作业端）两个子系统。

核心功能模块：
1. **责任田管理**：台区/高压用户的责任人配置和工单类型分配
2. **派工策略**：基于承载力、优先级、评分的智能派工
3. **人员管理**：作业人员的能力评估和工单类型配置
4. **地图可视化**：供电区域边界绘制、台区/用户聚类展示
5. **批量导入**：Excel 模板批量配置责任人和工单类型
6. **业务类型配置**：供电公司级别的工单类型和电压等级管理

### 已积累的洞察（10条）

#### 洞察 1：责任田模块的业务定位

**问题**：责任田模块的业务定位是什么？它解决什么问题？

**答案摘要**：
> 责任田是电力行业中对供电辖区内设备/用户进行责任划分的管理模块。核心解决的问题：
> 1. 每个台区（变压器供电范围）和高压用户，都要明确谁负责维护、负责哪些工单类型
> 2. 责任人需要配置负责的工单类型（如故障抢修、装表接电、用电检查等）
> 3. 当工单到来时，根据策略（承载力/优先级/评分）自动选择最合适的责任人
>
> 类比：就像农村分田到户，每个田（台区/高压用户）都有明确的农户（责任人）负责。

**分类**：架构设计  
**标签**：责任田, 业务定位, 模块概述  
**相关文件**：
- `work/src/components/pages/responsibilityFied/index.vue`
- `work/src/router/routes.js`

---

#### 洞察 2：责任田模块的组件结构

**问题**：责任田模块的组件结构是怎样的？

**答案摘要**：
```
index.vue（入口，加载地图 SgMap）
└─ Main.vue（地图覆盖层主容器）
     ├─ MapTopInfo.vue（顶部概览：供电所名称、队伍数、人员数、台区/高压用户维护统计）
     │    ├─ SelectOrgItem（单位切换）
     │    ├─ WorkTeamDialog（作业队伍列表弹窗）
     │    └─ StaffDialog（人员详情弹窗）
     ├─ MapLeftStation.vue（左侧供电所视图）
     ├─ MapLeftCounty.vue（左侧区县视图）
     ├─ MapRightDetail.vue（右侧详情面板）
     └─ MapRightStaffDetail.vue（右侧人员详情）
```

**分类**：架构设计  
**标签**：责任田, 组件结构, 组件树  
**相关文件**：
- `work/src/components/pages/responsibilityFied/index.vue`
- `work/src/components/pages/responsibilityFied/components/Main.vue`
- `work/src/components/pages/responsibilityFied/components/MapTopInfo.vue`
- `work/src/components/pages/responsibilityFied/components/MapLeftStation.vue`
- `work/src/components/pages/responsibilityFied/components/MapLeftCounty.vue`
- `work/src/components/pages/responsibilityFied/components/MapRightDetail.vue`
- `work/src/components/pages/responsibilityFied/components/MapRightStaffDetail.vue`

---

#### 洞察 3：责任田模块的两种显示模式

**问题**：责任田模块的两种显示模式和电压分类切换逻辑是什么？

**答案摘要**：
> 责任田模块支持两种显示模式：供电所视图和区县视图，通过电压分类进行切换...

**分类**：功能实现  
**标签**：责任田, 显示模式, 电压分类, 状态筛选  
**相关文件**：
- `work/src/components/pages/responsibilityFied/components/MapLeftStation.vue`
- `work/src/components/pages/responsibilityFied/components/MapLeftCounty.vue`

---

## 项目二：智能巡视

### 项目概况

- **项目名称**：智能巡视
- **项目路径**：`/Users/qujinpeng/hzwq/project/smart-patrol`
- **技术栈**：Vue + UniApp + uview-ui + NARIMap SDK + pako
- **业务领域**：电力设备智能巡检

### 业务总结

智能巡视是一个基于 UniApp 的智能巡检系统，主要用于电力设备的巡检工作。

核心功能模块：
1. **智能巡检**：支持离线巡检、实时上报、数据压缩
2. **白名单管理**：设备白名单申请、审批、离线处理
3. **同源拓扑**：低压台区拓扑图渲染和交互
4. **安全插件**：设备安全检测
5. **数据分析**：巡检数据统计和分析

业务特点：
- 支持离线操作，网络恢复后自动上报
- 设备白名单机制，支持审批流程
- 拓扑图可视化，支持交互式操作
- 跨页面数据传递，支持复杂业务流程

### 已积累的洞察（24条）

#### 洞察 1：同源拓扑的设计定位

**问题**：同源拓扑的设计定位、核心作用、与底层依赖关系及与普通网络拓扑的本质区别是什么？

**答案摘要**：
> **一、核心定位**
> 同源拓扑是「资源 / 网络 / 拓扑」三层架构中的顶层展示与交互层，用于直观呈现共享数据池和共享通道构成的底层资源如何组合为具体的网络业务逻辑。
>
> **二、核心作用**
> 1. 可视化业务逻辑：将共享数据池和共享通道构成的底层资源，按照网络业务的实际运行逻辑组装为可视化拓扑，让抽象的资源关系变为可直观理解的组网关系。
> 2. 统一多网络展示框架：为 VXLAN、IPv6、RoCE 等不同网络类型提供统一的展示框架...

**分类**：架构设计  
**标签**：同源拓扑, 架构设计, 资源层, 通道层, 拓扑可视化, 共享数据池, 共享通道  
**相关文件**：
- `pages/index/index.vue`

---

#### 洞察 2：同源拓扑功能涉及的核心文件

**问题**：同源拓扑功能涉及哪些核心文件，组件间的关系是怎样的？

**答案摘要**：
> 同源拓扑功能涉及4个核心文件：
> 1. `pages/index/index.vue` — 首页，包含一个 test() 方法用于测试跳转到同源拓扑页面
> 2. `pages/site-patrol-home/site-patrol-home.vue` — 巡视结果确认页（主页面），包含同源模块的显隐控制、数据初始化和提交逻辑
> 3. `pages/site-patrol-home/site-patrol-home-space.vue` — 空间拓扑组件
> 4. `pages/spatial-topology-rela/spatial-topology-rela.vue` — 同源拓扑关系页面

**分类**：架构设计  
**标签**：同源拓扑, 组件关系, 架构, 空间拓扑, NARIMap  
**相关文件**：
- `pages/index/index.vue`
- `pages/site-patrol-home/site-patrol-home.vue`
- `pages/site-patrol-home/site-patrol-home-space.vue`
- `pages/spatial-topology-rela/spatial-topology-rela.vue`

---

#### 洞察 3：同源拓扑的跨页面数据传递

**问题**：同源拓扑功能中跨页面数据传递的完整数据流是怎样的？

**答案摘要**：
> 同源拓扑使用 UniApp 的 eventChannel 机制实现跨页面数据传递...

**分类**：数据流  
**标签**：同源拓扑, 数据流, eventChannel, 跨页面通信, 挂接  
**相关文件**：
- `pages/site-patrol-home/site-patrol-home.vue`
- `pages/spatial-topology-rela/spatial-topology-rela.vue`

---

## 使用效果

### 知识积累

- **分级管控**：10 条洞察，覆盖责任田、派工策略、人员管理等核心模块
- **智能巡视**：24 条洞察，覆盖同源拓扑、白名单、离线巡检等核心功能

### 知识复用

当再次提问时，AI 会自动检索已有洞察：

```
用户：责任田模块是怎么切换供电所和区县视图的？

AI：让我先检索一下已有知识...
    🔍 找到 3 条相关洞察记录
    - 责任田模块的业务定位
    - 责任田模块的组件结构
    - 责任田模块的两种显示模式
    
    根据已有知识，责任田模块的视图切换逻辑如下...
```

### 知识演进

当代码变更时，可以通过 P0-2 的新鲜度机制检测知识是否过期：

```
🟢 有效 — 知识仍然可信
🟡 可能过期 — 依赖的代码可能已变更
🔴 已失效 — 依赖的代码已确认变更
```

---

## 总结

通过 `project-analysis-mcp`，我们实现了：

1. **知识持久化** — AI 的分析结果不再丢失
2. **知识结构化** — 按分类、标签、文件关联组织
3. **知识可检索** — 避免重复分析，提升效率
4. **知识可追溯** — 每条知识都有版本和状态
5. **知识可验证** — 文件快照支持新鲜度检查（P0-2）
