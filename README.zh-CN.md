# Veyra

[English](README.md) · [简体中文](README.zh-CN.md)

**为编码智能体提供持久化工程记忆。** Veyra 学习你的智能体已经付出代价换来的教训，记住那些经受住检验的，并在同样的问题再次出现时把它们放回智能体面前。

本地 SQLite。按工作区隔离。无守护进程。无 API 密钥。无需手动收藏。无需下周再推导一遍同样的根因。

[![npm](https://img.shields.io/npm/v/@lovedolove/veyra?color=16a34a)](https://www.npmjs.com/package/@lovedolove/veyra)
[![CI](https://github.com/LoveDoLove/Veyra/actions/workflows/ci.yml/badge.svg)](https://github.com/LoveDoLove/Veyra/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D22.12%20%3C25-16a34a)](package.json)
[![license](https://img.shields.io/badge/license-MIT-16a34a)](LICENSE)

[DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 的插件。本地 SQLite 存储。无守护进程。无 API 密钥。打包后 273.1 kB。纯 ESM。

---

## 问题

编码智能体的上下文窗口是工作集，不是存储。每个会话它都要重新学习同样的东西。

- 为什么构建需要那个标志。
- 哪个修复试过又被否决，以及它破坏了什么。
- 这个模块在迁移落地前必须保持不动。
- 文件改动后，这些事实中哪些不再成立。

对话历史不会跨会话保留。文档会与代码脱节。一文件夹的 markdown 笔记没有生命周期，没有权威级别模型，也无法告诉你它已经过期。

## Veyra 做什么

Veyra 把智能体已经做过的工作转化为持久、有证据支撑的记忆，并自动注入相关部分。

| | |
| --- | --- |
| **无需请求即可捕获** | Veyra 监听会话事件，把每个回合提炼为一条观察。受治理的闸门决定它是否赢得记忆中的位置。没有产生持久价值的回合会被丢弃，而不是存储。 |
| **无需请求即可召回** | 在回合开始时，最相关的记录会被注入上下文，每条都标注其信任状态。注入的策略还要求智能体在任何非琐碎任务开始时，先主动发起一次精准的 `veyra_recall` 检索，让关键词匹配的注入背后多一层按需搜索。 |
| **拒绝凭空造证据** | 散文中提到的路径不是改动过的文件。句子中的符号名不是符号。只有真实、已解析的锚点才能支撑一条记录。 |
| **知道什么时候可能出错** | 每条召回记录都会对照当前仓库重新检查，并分类为 `trusted`、`review_required`、`stale`、`contradicted` 或 `insufficient_evidence`。 |
| **永远不做事实来源** | 仓库永远优先。`canonical` 权威级别只能通过显式的人工操作达到。不会向你的仓库写入任何内容。 |
| **让工作区彼此隔离** | 记忆按 DSH 工作区身份划分为房间，绝不按文件系统路径。同一仓库上的两个工作区永远看不到彼此的记忆。 |

## 快速开始

```sh
dsh plugin --profile web add @lovedolove/veyra
```

重启 DSH，安装就完成了。

如果 DSH 安装的版本比上方 npm 徽章显示的更旧，可能是包管理器的供应链发布年龄策略暂缓了最新发布。可以显式安装当前版本：

```sh
dsh plugin --profile web add @lovedolove/veyra@0.3.1
```

然后正常干活。在产生了持久价值的回合结束时，Veyra 会存储它。在同一工作区的下一个回合开始时，它又会出现。

检查一下：

```
/veyra                  本工作区状态
/veyra recent           已存储的内容，包括候选记录
/veyra recall sqlite wal
/veyra inspect vey_…
```

在 DSH Web 地址栏打开 `/veyra`，即可把同一份记忆看作图。

## 循环

```
   work happens
        │
        ▼
   observe ──► observation ──► write gate ──► derived memory
   (what changed,             (accept /        (recall-eligible)
    what passed,               merge /
    what was tried)            drop / defer)
        │                          │
        │                          ▼
        │                     SQLite + FTS5
        │                     one room per workspace
        ▼                          │
   next turn ◄── trust check ◄─────┘
              (fresh? contradicted? checkable?)
```

四件事让这个循环保持诚实：

1. **捕获需要证据。** 真正改动过的文件，真正运行过的测试，真正被陈述的根因。
2. **学习需要持久性。** 一次性命令不是教训。
3. **召回需要相关性。** 对词法、语义、意图和图信号做混合检索，并给出可见的分数明细。
4. **复用需要新鲜度。** 代码移动后，描述它的记忆会被降级。

## 两层，一条规则

| 层 | 回答的问题 | 事实来源 |
| --- | --- | --- |
| **Veyra 记忆** | 我们吃过哪些苦头才学到？ | 按工作区累积的证据 |
| **代码智能** | 代码现在是什么样？ | 实时仓库 AST |

代码智能是可选的，位于单独的插件中。它可以把一条记忆标记为过期。它永远不能覆盖记忆。

**双向的规则：仓库事实优先。** 一条声称代码做了某事的记忆，是需要验证的主张，不是可以据以行动的事实。

## 记忆规则

| 类型 | 权威级别 | 自动召回 |
| --- | --- | --- |
| 自动捕获的观察 | `candidate` | 否 |
| 学到或显式记住的教训 | `derived` | 是 |
| 显式提升的事实 | `canonical` | 是 |

相似不等于相同，因此重叠的记忆会被关联，而不是合并。相似不等于权威级别，因此再好的匹配也不会提升一条记录。

## 文档

| 文档 | 涵盖内容 |
| --- | --- |
| [文档索引](docs/README.md) | 按读者分组的全部文档 |
| [白皮书](docs/WHITEPAPER.md) · [简体中文](docs/WHITEPAPER.zh-CN.md) | 愿景、设计原则、架构、核心概念、技术设计、未来方向 |
| [记忆模型](docs/reference/memory-model.md) | 权威级别、验证状态、种类、因果维度、生命周期、信任、房间与提升 |
| [工具](docs/reference/tools.md) | 全部十一个工具、它们的参数，以及三个内置技能 |
| [命令](docs/reference/commands.md) | 每个 `/veyra` 命令，包括观测台 |
| [配置](docs/reference/configuration.md) | 设置、环境变量、存储布局、重置 |
| [代码智能](docs/reference/code-intelligence.md) | 可选的结构层、安装、降级、新鲜度 |
| [故障排查](docs/reference/troubleshooting.md) | 症状、原因、修复 |
| [基准测试](docs/BENCHMARK.md) | 已测量的 45 维基准测试装置，以及每个数字的含义 |
| [架构图](docs/architecture-graph.md) | 契约、已拒绝的方案，以及长期有效的设计边界 |
| [CHANGELOG.md](CHANGELOG.md) | 每个已发布版本，以及其中改了什么 |
| [检索有效性](RETRIEVAL-EFFECTIVENESS-GOAL.md) | 目标、实验，以及检索工作证明了什么的记录 |
| [贡献指南](CONTRIBUTING.md) | 如何报告、提议、验证和提交一项改动 |
| [安全策略](SECURITY.md) | 支持的版本、存储了什么、脱敏了什么、威胁模型 |
| [AGENTS.md](AGENTS.md) | 为开发 Veyra 本身的智能体提供的入口 |

## 要求

| | |
| --- | --- |
| Node | `>=22.12.0 <25.0.0`（`node:sqlite`，以及桥接层使用的未加标志的 `require(esm)`） |
| DSH | `>=0.1.2-rc.1 <0.3.0-0` |
| 存储 | `node:sqlite` + FTS5，位于 `$DSH_HOME/veyra/` 或 `$VEYRA_HOME` 下 |
| 运行时依赖 | 无必需项。Codebase Memory 是可选的对等依赖 |

按 profile 安装（`web`、`tui` 等）。网络图需要 web 界面。

## 测量了什么，没测量什么

已测量：记忆循环能够闭合。一次召回分发是可观测的，重复召回是有界的，重述的根因会合并，捕获不再凭空造证据。测试套件有 1173 个测试，基准测试装置在每次运行时重新断言自己的表格。

未测量：带 Veyra 的智能体是否比不带的更快或更好地完成真实任务。这需要配对实验，仓库如实说明这一点，而不是暗示相反。白皮书把设计目标、已实现行为、已验证行为和未证实主张分放在不同章节。

## 开发

```sh
npm test               # node --test test/*.test.mjs
npm run pack:check     # 将会发布的内容
```

CI 在 Node 22 和 24 上都会运行这两项。适用于此处改动的规则见 [AGENTS.md](AGENTS.md)。

## 许可证

MIT。见 [LICENSE](LICENSE) 与 [THIRD_PARTY.md](THIRD_PARTY.md)。

Veyra 尚未到 1.0。命令界面和 API 仍可能在次版本之间变化。
