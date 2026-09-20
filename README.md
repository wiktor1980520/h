# 素人AI换装 · Cloudflare 全托管

人物图 × 电商链接 → **15s 女装试穿短视频** → 自动发布（抖音挂车 / 小红书 / 视频号）。
后端全部运行在 Cloudflare 边缘，无自建服务器。

## 架构

```
浏览器
  │  静态资源(./public)
  ▼
Cloudflare Worker (src/index.ts)   ← 单一入口，Serving Assets + REST API
  ├─ D1 (JobStore)                 任务元数据/状态（SQLite 等价物，媲美本地数据库）
  ├─ R2 (MEDIA_BUCKET)             人物图 / 商品图 / 试穿图 / 成品视频
  └─ Workflows (HuangtoolsPipelineWorkflow)
       parse(电商链接抽图) → ingest进R2 → tryon(虚拟试穿) → video(图生视频) → publish(多平台)
  └─ Workers AI (env.AI)           可选：商品分类等 LLM 推理
```

| 环节 | 技术 | 说明 |
|------|------|------|
| 任务编排 | **Workflows** | 长时多步骤：解析→试穿→图生视频→发布，天然重试/幂等/可观测 |
| 任务数据库 | **D1** | 云端 SQLite（原“本地数据库”诉求的云等价物） |
| 对象存储 | **R2** | 输入图片与成品视频，零出口流量费 |
| 前端 | **Workers Static Assets** | 单文件 SPA，与 API 同域免跨域 |
| 虚拟试穿 | 外部托管 `DASHSCOPE_API_KEY`（百炼 OutfitAnyone/IDM） | Workers AI 暂无可用 VTON |
| 图生视频 | 外部托管 `kling-v3` / `seedance`（DashScope 风格） | Workers AI 暂无稳定图生视频 |
| 发布 | 抖音开放平台 / 视频号开放平台 / 小红书 RPA Webhook 桥 | 见下 |

## 目录

```
migrations/0001_init.sql   D1 表结构（jobs / publish_log）
migrations/0002_app_config.sql  第三方 key 配置表（写入数据库）
public/                    前端（index.html / styles.css / app.js）
src/
  index.ts                 Worker 入口 + REST API + /media 回源 + /api/config
  env.ts                   绑定类型
  types.ts                 任务领域模型
  store/d1.ts              D1 任务存取
  store/config.ts          第三方 key 数据库配置（AES-GCM 加密落库，env 兜底）
  storage/r2.ts            R2 存取 / dataURL / 下载落库
  workflow/pipeline.ts     多步骤编排核心
  providers/               async(DashScope)、parser(电商解析)、vton、video、llm、http
  publish/                 douyin / weixin / xiaohongshu + 注册表
```

## 第三方 key 配置（写入数据库）

抖音/小红书/大模型等第三方凭据 **无需再用 worker 环境变量**，前端「配置」面板或 API 直接写入 D1 `app_config` 表，运行时优先读取（env 兜底）：

- `GET /api/config` → 各键是否已配置（值掩码，不泄露明文）
- `POST /api/config`   body `{ "values": { "DOUYIN_ACCESS_TOKEN": "xxx" } }`，值为空串即删除该键
- 落库前用 `DATA_ENCRYPTION_KEY`（Cloudflare Secret）做 AES-GCM 加密；未设置则明文
- 可选 `CONFIG_TOKEN`（Cloudflare Secret）保护写接口，前端填写后以 `Authorization: Bearer` 提交

应用迁移：`wrangler d1 migrations apply DB`（本地 `--local`）

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 填入 DASHSCOPE_API_KEY 等
# 本地起 D1（自动使用 .wrangler/state 里的本地 sqlite）
npm run db:migrate:local
npm run dev                      # http://localhost:8787
```

## 部署（一次性初始化）

```bash
# 1. 创建资源并把真实 id 回填 wrangler.jsonc
wrangler d1 create huangtools-db          # → 更新 database_id
wrangler r2 bucket create huangtools-media
# 2. 应用迁移到远端 D1
npm run db:migrate
# 3. 注入密钥（替代全局变量，更安全）
wrangler secret put DASHSCOPE_API_KEY
# 4. 部署
npm run deploy
```

Workflow 观察：`npm run wf:instances`；仪表盘在 Workers 控制台的 **Workflows** 页。

## REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/jobs` | 新建任务，body: `{personImageURL, garmentType, garmentValue, resolution, duration, withSound, publish[]}` |
| GET  | `/api/jobs?status=&cursor=&limit=` | 任务列表 |
| GET  | `/api/jobs/:id` | 任务详情 |
| POST | `/api/jobs/:id/cancel` | 取消（并终止 Workflow 实例） |
| DELETE | `/api/jobs/:id` | 删除记录 |
| GET  | `/media/<r2key>` | R2 媒体回源（图片/视频） |
| POST | `/v1/webhooks/xhs` | 小红书 RPA 完成回调 |

## 发布说明

- **抖音**：开放平台 `video/upload/` + `video/create/`（可加 `ecom_carousel` 挂车）。需 `DOUYIN_ACCESS_TOKEN`。
- **视频号**：开放平台 `channels/ec/vod/upload` + `add`。需 `WEIXIN_CHANNELS_ACCESS_TOKEN`。
- **小红书**：无官方 API，采用 **Webhook 桥**：Worker 触发本地 RPA（浏览器自动化）发布并挂车，完成后回调 `/v1/webhooks/xhs` 更新状态。

> 第三方平台接口字段以官方文档为准；本项目为可运行骨架，接入真实密钥后按需微调请求体即可。

## 模型链路（二选一，二者都预留）

- **外部托管（默认）**：`DASHSCOPE_API_KEY` + `TRYON_MODEL`/`VIDEO_MODEL`，DashScope 异步任务 + 轮询。
- **Workers AI 评估路径**：`USE_WORKERS_AI_LLM=true` 让商品分类走 `env.AI`；试穿/视频因 Workers AI 尚无对应模型会明确报错提示，便于将来接入。