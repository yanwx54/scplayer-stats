# STARCRAFT 战术情报终端

韩国星际争霸职业选手战绩查询工具，数据源为 [eloboard.com](http://eloboard.com/men)。支持选手对战查询、地图情报分析、交战记录回顾。

## 功能特性

- **交战摘要** — 双方 ELO、胜率、总比分、近 30 天战绩、ELO 差值
- **赛季地图直接交锋** — 双方在 7 张本赛季地图上的 H2H 胜负
- **地图总战绩（分对抗）** — 每位选手在每张地图上 vs T/Z/P 的胜率
- **近 3 个月交战记录** — 双列紧凑布局，分页展示，支持地图筛选
- **本地数据库** — 全量数据同步至本地 JSON 文件，查询毫秒级响应

## 技术栈

- **后端**：Node.js + Express
- **数据抓取**：axios + cheerio
- **前端**：原生 HTML / CSS / JavaScript（无框架）
- **存储**：JSON 文件（零依赖，每选手一个文件）

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 同步数据（首次必须）

从 eloboard.com 抓取所有选手数据到本地：

```bash
npm run sync          # 全量同步（约 8 分钟）
node sync.js 15       # 单选手同步（按 wrId）
npm run sync:status   # 查看本地数据库状态
```

### 3. 启动服务

```bash
npm start
```

浏览器访问 http://localhost:3000

## 项目结构

```
scplayer-stats/
├── server.js              # Express 服务器 + API 路由
├── db.js                  # 数据层：页面解析、本地存储、统计计算
├── sync.js                # 数据同步脚本（命令行）
├── package.json
├── public/                # 前端静态资源
│   ├── index.html         # 主页面
│   ├── app.js             # 前端逻辑
│   ├── style.css          # 样式
│   └── maps.json          # 赛季地图配置
├── data/                  # 本地数据库（同步后生成）
│   ├── players/           # 每选手一个 JSON（含全量对战记录）
│   └── meta.json          # 同步元信息
└── docs/
    └── 韩国选手个人主页列表.md  # 选手清单（60 人）
```

## API 接口

| 接口 | 说明 | 数据源 |
|------|------|--------|
| `GET /api/players` | 选手列表 | 本地 MD 文件 |
| `GET /api/maps` | 赛季地图配置 | 本地 JSON |
| `GET /api/fight?player1=&player2=` | 双方对战摘要 | 远程抓取（缓存 1 小时） |
| `GET /api/player-map-stats?wrId=` | 选手地图总战绩（分对抗） | 本地库 |
| `GET /api/recent-matches?wrId1=&wrId2=` | 近 3 个月交战记录 | 本地库 |
| `GET /api/status` | 数据库状态 | 本地 |
| `GET /api/sync-player?wrId=` | 同步单选手 | 远程抓取 |
| `GET /api/sync-all` | 全量同步（后台） | 远程抓取 |

## 赛季地图

当前赛季地图配置在 `public/maps.json`，可按赛季更新：

| 韩文 | 中文 | 版本 |
|------|------|------|
| 오디세이 | 奥德赛 | RE 2.0 |
| 컬러리스 페이트 | 无色命运 | 1.1 |
| 아이올로스 | 艾洛斯 | 1.0b |
| 녹아웃 | 击倒 | 1.4 |
| 백 룸 | 后室 | 1.1 |
| 애티튜드 | 态度 | SE 2.1 |
| 옥타곤 | 八角笼 | SE 2.0 |

## 数据说明

- **选手范围**：`docs/韩国选手个人主页列表.md` 中的 60 位韩国职业选手
- **比赛数据**：每选手包含 board 0 近期比赛 + board 1 storyb 全量对战（vs 每个对手的生涯完整记录）
- **ELO 显示**：胜者加分恒为正值（如 `+16.8`），负方取反
- **交战记录**：合并双方主页数据去重，覆盖更完整

## 日常维护

- 建议每周运行一次 `npm run sync` 刷新数据
- 页面顶部「同步数据」按钮可触发后台全量同步
- 选人时会自动后台静默刷新该选手数据

## 数据源

[eloboard.com](http://eloboard.com/men) — 韩国星际争霸 ELO 排行榜与选手主页

## License

MIT
