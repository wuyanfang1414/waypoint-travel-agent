# Waypoint Travel Planning Agent

Waypoint 是一个只做旅行规划的垂直 AI Agent。用户输入出发地、目的地、预算、日期、天数、同行人数、兴趣、节奏和住宿偏好后，系统生成逐日路线、酒店档位、城际/市内交通、费用拆分与约束检查。

它解决的不是“再列一遍热门景点”，而是：**在互相冲突的偏好和硬约束中，产出一份走得通、付得起、能解释的方案。**

![Waypoint 旅行规划工作台](docs/waypoint-desktop.png)

## 快速运行

```powershell
cd .\travel-planner-agent
.\start.ps1
```

打开 `http://127.0.0.1:8877`。

同一 Wi-Fi 下用手机访问：

```powershell
.\start-lan.ps1
```

脚本会显示类似 `http://192.168.1.23:8877` 的局域网地址。手机和电脑必须连接同一 Wi-Fi；Windows 防火墙首次询问时只允许“专用网络”即可。`127.0.0.1` 永远指当前设备，因此不能直接作为手机或异地访问地址。

项目默认无外部依赖，使用 Python 标准库和原生 Web 技术。没有 API Key 也能完成整个 Agent 工作流。

Docker：

```bash
docker build -t waypoint-agent .
docker run --rm -p 8877:8877 waypoint-agent
```

### 部署成公网网址

项目包含 `render.yaml`。将 `travel-planner-agent` 目录推送到 GitHub 后，可在 Render 创建 Blueprint/Web Service，启动命令为：

```bash
python server.py --host 0.0.0.0
```

服务会自动读取平台提供的 `PORT` 环境变量。公网部署后会得到一个 `https://...` 地址，手机和异地面试官都能访问。是否配置 `OPENAI_API_KEY` 不影响核心规划功能。

## 项目目标

### 用户目标

1. 用少量输入快速得到第一版旅行方案。
2. 看到预算如何分配，而不是只看一个总价。
3. 减少跨片区折返、重复景点和强度失控。
4. 理解系统为什么推荐某个景点、酒店和交通方案。
5. 明确哪些是规划估算、哪些必须在预订前实时复核。

### 产品目标

- 让“偏好”真正改变结果，而不是只改变开头的一段文案。
- 将模型擅长的语言理解与工具擅长的确定性计算分开。
- 无密钥、断网或模型异常时仍能现场演示。
- 把不确定性和限制展示给用户，不假装拥有实时房态和票价。

## Agent 工作流

```mermaid
flowchart LR
    A["用户偏好"] --> B["Preference Interpreter"]
    B --> C["Destination Search"]
    C --> D["Budget Allocator"]
    D --> E["Route Optimizer"]
    E --> F["Weather Adapter"]
    F --> G["Constraint Validator"]
    G --> H["Plan Composer"]
    H --> I["行程 / 酒店 / 交通 / 预算"]
    G -. "锁定事实后" .-> J["GPT-5 mini Narrator"]
    J -. "只优化解释" .-> H
```

### 工具职责

| 工具 | 输入 | 输出 | 为什么不用模型直接完成 |
|---|---|---|---|
| Preference Interpreter | 表单偏好 | 标准化约束 | 防止天数、人数和预算格式漂移 |
| Destination Search | 兴趣、预算、无障碍偏好 | POI 候选与分数 | 推荐必须能回溯到数据字段 |
| Budget Allocator | 总预算、人数、天数、交通 | 六类费用 | 金额必须可重复计算 |
| Route Optimizer | POI 片区、时长、节奏 | 逐日路线 | 限制重复与跨片区折返 |
| Weather Adapter | 城市坐标、日期 | 预报或季节提示 | 需要真实来源和失败回退 |
| Constraint Validator | 行程、预算、补充要求 | 警告与可行性 | 必须诚实暴露超预算和未验证要求 |
| Plan Composer | 已锁定方案 | 展示与导出 | 不允许文案层修改数字和地点 |

## 技术选型

### 前端

- 原生 HTML、CSS、JavaScript。
- 响应式工作台，支持桌面和手机。
- LocalStorage 保存方案，不默认上传用户偏好。
- Markdown 导出，方便复制到 Notion、邮件或作品集。

选择无构建前端是为了让面试官拿到项目后能立即运行，并减少依赖安装造成的演示风险。

### 后端

- Python 3 标准库 `ThreadingHTTPServer`。
- 规划算法、API、天气适配和静态文件服务都不依赖第三方包。
- `/api/plan` 执行完整工具链，`/api/health` 暴露运行模式与数据集版本。

### 模型

**可选模型：`gpt-5-mini`，通过 OpenAI Responses API 调用。**

使用场景：

- 将结构化偏好和已确定方案总结成自然语言。
- 解释“为什么这样排”和预订提醒。
- 不负责生成景点、酒店、票价、预算或路线。

选择理由：

- 旅行解释需要较好的中文理解，但不需要每次都使用最高成本模型。
- Responses API 支持 Agent 工作流与工具调用；GPT-5 系列支持 Responses API。
- 本项目将模型设置为可替换环境变量，避免架构绑定单一模型。

官方参考：

- [Migrate to the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Using tools with the OpenAI API](https://developers.openai.com/api/docs/guides/tools)

启用模型：

```powershell
$env:OPENAI_API_KEY = "your-key"
$env:OPENAI_MODEL = "gpt-5-mini"
python server.py --port 8877
```

API Key 仅由服务端读取，不会返回浏览器。模型失败时自动保留本地规划结果。

## 数据集

### 本地知识库

`Waypoint Curated China City Seed v1.0.0`

- 5 个城市：上海、杭州、苏州、成都、北京。
- 40 个结构化 POI。
- 15 个分档酒店参考。
- 8 条主要城际连接。
- 每个城市包含市内交通和季节性提示。

POI 字段：

| 字段 | 用途 |
|---|---|
| `tags` | 与历史、美食、摄影、自然、艺术、亲子等兴趣匹配 |
| `area` | 按片区聚类，减少折返 |
| `duration` | 计算单日强度 |
| `price` | 预算分配与低预算降权 |
| `coords` | 为后续地图和真实距离矩阵预留 |
| `indoor` | 雨天替代和高温场景 |
| `priority` | 冷启动基础排序 |

这不是训练数据集，而是**推理时使用的结构化目的地知识库**。模型没有被重新训练。

### 实时数据

- Open-Meteo：在预报时间窗内读取目的地天气，无需 API Key。
- 网络失败或日期超出预报范围时，回退到城市季节性提示。

### 数据边界

- 酒店名称和价位仅是档位示例。
- 门票、房态、开放时间和交通班次可能变化。
- 输出明确标注“规划参考”，预订前必须访问官方或预订平台复核。

## 产品与用户思考

### 1. 预算语义必须明确

表单把预算定义为“全部同行人的总预算”，避免用户误以为是人均预算。结果拆成大交通、住宿、餐饮、门票、市内交通和机动预算。

### 2. 偏好不应该只是 Prompt 装饰

兴趣会改变 POI 分数；节奏会改变每天的景点上限；无障碍开关会降低长徒步项目；酒店档位会改变住宿选择和餐饮估算。

### 3. 规划和预订是两件事

系统负责生成决策框架，不负责声称“这个房间仍有库存”。产品界面始终显示数据来源、参考区间和复核提醒。

### 4. 解释性比神秘分数更重要

Agent Trace 展示每一步工具。预算页展示约束警告；逐日行程展示片区、时长、门票与室内外属性。

### 5. 对无法验证的要求保持诚实

用户输入“不吃辣”时，系统只记录要求并提示向商家人工确认，不会声称所有餐厅都已满足。

### 6. 为首次使用降低认知成本

首页不是营销落地页，而是可以直接操作的规划工作台；同时提供杭州 3 日示例，让用户先看结果再理解输入。

## 评估与测试

运行：

```bash
python -m unittest discover -s tests -v
```

当前 8 个行为测试覆盖：

- 行程不出现重复景点。
- 茶文化兴趣会提高龙井或茶叶博物馆的优先级。
- 低预算跨城方案必须显示超预算警告。
- 松弛节奏每天最多两个核心景点。
- 低碳偏好在上海—北京线路选择高铁。
- 7 日方案在 POI 足够时不生成空白日。
- 补充要求不会被错误标记为已满足。
- Trace 必须包含约束校验工具。

## 项目结构

```text
travel-planner-agent/
├── agent.py                 # 检索、预算、路线、天气、校验、模型增强
├── server.py                # API 与静态服务
├── data/cities.json         # 结构化目的地知识库
├── tests/test_agent.py      # Agent 行为评估
├── web/
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── assets/travel-panorama.jpg
├── PROJECT_BRIEF.md         # 面试讲解稿
└── Dockerfile
```

## 简历描述

中文：

> 独立设计并实现 Waypoint 旅行规划 Agent，将用户预算、时间、兴趣、节奏和无障碍偏好转化为逐日行程；构建目的地检索、预算分配、片区路线优化、天气适配和约束校验工具链，并支持 GPT-5 mini / Responses API 可选解释层与无模型回退。

English:

> Designed and built Waypoint, a constraint-aware travel planning agent that transforms budget, time, interests, pace, and accessibility preferences into daily itineraries using POI retrieval, budget allocation, area-based route optimization, weather adaptation, and validation tools, with an optional GPT-5 mini narrative layer and deterministic fallback.

## 后续演进

- 接入地图距离矩阵，替代当前片区近似。
- 接入酒店和交通实时库存，仅在用户授权后跳转预订。
- 增加多城市串联和同行人偏好协商。
- 用真实用户选择数据校准 POI 排序权重。
- 建立离线评估集，衡量预算误差、兴趣命中率和路线折返距离。
