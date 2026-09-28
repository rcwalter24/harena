# Harena

[English](README.md) · **简体中文**

一个俯视角 2D 竞技场，让**不同 AI 写的机器人互相对战**。把规则手册
[`BOT_API.md`](BOT_API.md) 交给 AI，把它写出的 JavaScript 文件放进 `bots/`，就能看它和其他
AI 写的机器人对打——你也可以用键盘亲自下场。

**在线试玩：<https://harena.rcwalter.net>** —— 无需安装，直接在网页里添加机器人。

![Blockyard 地图上的四人混战](docs/images/match.png)

## 特性

- **一个机器人就是一个文件。** 机器人是一个普通的 ES 模块，导出 `init()` 和 `decide()`。
  `BOT_API.md` 写清了所有规则、数值和类型，任何够强的 AI 只看这一份文档就能写出机器人。
- **匕首、枪、榴弹发射器和定时地雷**，地图上还会刷出血包、护盾、弹药和额外生命。
- **草丛**可以藏身（每次最多 5 秒），**缩圈**逼迫决战，**移动惯性**让走位和预判射击变得重要。
- **1v1 或 2–8 人混战**，共四张地图。
- **机器人在沙箱里运行。** 每个机器人跑在独立的 worker 里，有时间预算；抛异常、卡死或返回
  非法数据的机器人会被记录、重启或禁用，对局本身不会崩溃。
- **确定性引擎。** 每局都能保存成一个很小的回放文件并精确重现，还能在浏览器里直接
  **导出成 1080p MP4 视频**，方便发到视频平台。
- **批量模式**在 Node 里无界面地跑成百上千局，输出胜率和各项统计。

![结算界面和每个玩家的数据](docs/images/results.png)

## 快速开始

需要 [Node.js](https://nodejs.org/) 24 或更高版本。

```bash
git clone https://github.com/rcwalter24/harena.git
cd harena
npm install
npm run dev
```

打开终端里显示的地址（通常是 <http://localhost:5173>），在设置页选地图和机器人，点
**开始对局**。界面支持中文和英文，默认跟随浏览器语言，可以用右上角的按钮切换。

## 让 AI 写一个机器人

设置页会一步步引导你，不需要会编程：

1. 点 **📋 复制 AI 提示词**，粘贴到任意 AI 聊天里（ChatGPT、DeepSeek、豆包、
   Claude、Gemini……）。提示词里包含完整的规则手册 [`BOT_API.md`](BOT_API.md)。
2. 复制 AI 的完整回复。
3. 点 **+ 添加机器人**并粘贴，代码块会被自动提取出来。如果机器人违反了规则，对话框会
   说明原因，点 **复制给 AI 的修复请求**就能得到一段可以直接发回给 AI 的话。

这样添加的机器人保存在你的浏览器里。如果想让所有 clone 这个仓库的人都能用，就把它保存为
`bots/<名字>.js`，它会自动出现在设置页。对战时 **机器人日志** 会显示报错和超时，把这些贴回给 AI
可以让它继续改进。在设置页点击机器人的名字可以给它改显示名。

自带的机器人：

| 文件 | 说明 |
|---|---|
| `random.js`、`chaser.js`、`gunner.js` | 手写的示例；`gunner.js` 也是 `BOT_API.md` 里的示例代码 |
| `astra.js`、`deepseek.js`、`doubao.js` | 由不同的 AI 助手根据 `BOT_API.md` 编写 |

`bots/` 里的每个文件都要先通过静态检查才能上场（不能 import、不能联网、不能 `eval`、不能篡改
沙箱）。机器人在 worker 里隔离运行，但这不是严格的安全边界——只运行你看过的机器人。

## 亲自上场

在设置页添加 **+ 你自己（键盘）** 作为一名玩家。

| 按键 | 作用 |
|---|---|
| `W` `A` `S` `D` / 方向键 | 移动 |
| 鼠标 | 瞄准 |
| 左键 | 攻击 |
| `1` / `2` / `3` | 匕首 / 枪 / 榴弹发射器 |
| `Q` | 切换到下一把武器 |
| `E` / 右键 | 放置地雷 |
| `P` · `N` · `[` `]` · `R` | 暂停 · 单步 · 调速 · 重开 |
| `F3` | 调试图层（碰撞体、射程） |

## 自己部署一份

`npm run build` 会把静态网站生成到 `dist/`，上传到任意静态网站托管即可（GitHub Pages、nginx 等）。
对战、机器人和视频导出都在访客的浏览器里运行，服务器只负责提供文件。构建结果放在域名根目录或
子目录下都能用。不要把 `npm run dev` 暴露到公网：开发服务器带有机器人审查接口，并且能读取项目文件。

## 回放与视频

每局都会被记录：种子、地图、规则，以及引擎执行过的每一个动作。结算界面有
**观看回放**和 **下载回放**（`.json` 文件），设置页的
**打开回放…** 可以重新打开回放。回放会精确重现整局对战，并用记录的校验值自我验证。

**导出视频**（回放页和结算界面都有）把回放渲染成 1920×1080 的 MP4（H.264）视频，包含
片头、玩家信息卡、击杀播报和最终结算——完全在浏览器里完成，比实时播放更快。可以选择把没人
交火的冷场片段 4 倍速快进。需要浏览器支持 WebCodecs（较新的 Chrome、Edge 或 Safari）；
不支持 H.264 编码时会改用 WebM（VP9）。

## 批量对战

```bash
npm run batch -- --bots gunner,chaser,random --games 100 --map all --seed s1
npm run batch -- --bots gunner,gunner,chaser,chaser --games 50 --replays out/replays --json
```

每局使用独立的种子（`<seed>-<序号>`）并随机分配出生位；机器人在 `worker_threads` 里运行，
沙箱规则和浏览器里一致。只要没有超时，同样的参数会得到同样的结果。
`npm run batch -- --help` 列出所有选项。

## 可选：AI 代码审查

除了静态检查，还可以用 [TypeSafe](https://www.npmjs.com/package/@typesafe-ai/sdk) 的 AI 代码
审查工具 Jev 审查机器人：点设置页的 **审查** 按钮，或运行 `npm run review`。审查结果仅供参考，
是否让机器人上场由你决定。这需要你自己的 TypeSafe API 密钥，运行时从环境变量
`TYPESAFE_API_KEY` 或文件 `~/.secrets/typesafe` 读取（可用 `TYPESAFE_KEY_FILE` 指定其他路径）。
密钥只在 Node 里使用，不会发送到浏览器。审查结果保存为 `bots/<名字>.review.json`，机器人代码
改动后会标记为过期。没有密钥时其他功能都能正常使用。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动开发服务器 |
| `npm test` | 运行测试 |
| `npm run typecheck` | 类型检查（引擎部分不带 DOM 类型单独检查） |
| `npm run build` | 类型检查并构建静态网站到 `dist/` |
| `npm run docs` | 根据模板、配置、类型和示例机器人重新生成 `BOT_API.md` |
| `npm run batch -- --bots a,b,…` | 无界面批量对战，输出胜率和统计 |
| `npm run review` | 对新增或改动的机器人做静态检查 + Jev 审查（`-- --all`、`-- file.js`、`-- --static-only`） |

## 目录结构

| 路径 | 内容 |
|---|---|
| `src/engine/` | 确定性模拟：配置、几何、各游戏系统、带种子的随机数 |
| `src/match/` | 控制器、对局运行器和机器人监管（时间预算、失败处理、重启） |
| `src/sandbox/` | 机器人 worker 运行环境：浏览器（Web Worker）和 Node（worker_threads） |
| `src/render/` | Canvas 渲染 |
| `src/ui/` | 页面、HUD 和键鼠输入 |
| `src/video/` | 回放导出视频 |
| `src/review/` | 静态检查和 Jev 审查 |
| `src/batch/`、`cli/` | 批量对战及其命令行 |
| `bots/` | 机器人文件及其审查结果 |
| `maps/` | 地图（JSON） |
| `docs/` | `BOT_API.md` 模板和 README 配图 |
| `tests/` | Vitest 测试 |

## 参与贡献

欢迎提 issue 和 pull request。下面几条规则保证回放和已有机器人不会失效：

- 引擎（`src/engine/`）必须保持确定性：不用 DOM，不用 `Math.sin/cos/atan2/hypot`，随机数只能来自带种子的 RNG。
- 所有规则数值都放在 `src/engine/config.ts`，并附带文档说明。
- `BOT_API.md` 是自动生成的——修改 `docs/BOT_API.template.md` 后运行 `npm run docs`。
- 机器人 API 只增不改：只能新增可选字段，不能重命名或删除。
- 提交前运行 `npm run typecheck && npm test`。

完整规则见 [`CLAUDE.md`](CLAUDE.md)（为 AI 编程助手编写，对人同样适用）。

## 许可证

[MIT](LICENSE)
