# PaperWeave · 拾题成卷

> **层级关系：** 本目录遵从 `~/codes/CLAUDE.md`（codes 工作区规则，其本身遵从 `~/.claude/CLAUDE.md`）。本文件是子项目规范，优先于上层同名文件。

## 项目是什么

面向教师本人的本地题库桌面应用：从原卷 PDF 录题、拆题打标签、审核入库，到检索选题、组卷、生成学生卷/教师答案卷双 PDF 并打印。覆盖小学至高中全学科，首版学科验收范围为小学语文、小学数学、初中语文、初中数学。

项目状态与交接进度见 [docs/HANDOFF.md](docs/HANDOFF.md)。

## 权威文档

- 产品行为以 [产品需求文档 V1](docs/产品需求文档-V1.md) 为准
- 技术路线见 [本地跨平台应用方案 V1](docs/本地跨平台应用方案-V1.md)
- 执行与验收按 [开发与验收流程 V1](docs/开发与验收流程-V1.md) 推进

规则与实现冲突时，先改对应文档、再改实现，不反向操作。

## 技术栈（已定，M0 实测后固定版本）

Electron + Node.js + TypeScript + React + Vite；SQLite + 本地文件目录；PDF.js 读卷、KaTeX 公式、Electron Forge 打包。验收平台 macOS Apple Silicon、Windows x64。

## 目录结构

| 目录 | 用途 |
|------|------|
| `docs/` | 方案、需求与研究文档（权威规则） |
| `research/` | 样本试卷与调研材料（`pdfs/` 不入库） |
| `src/` | 应用源码 |
| `scripts/` | 构建、迁移等脚本 |
| `tests/` | 测试；夹具放 `tests/fixtures/`，与业务数据分开 |
| `data/` | 应用静态数据 |
| `dist/`、`out/` | 构建与打包输出（不入库） |

## 开发约定

- 按 M0–M4 阶段推进；每阶段先写会失败的测试或验收步骤，再实现（详见开发与验收流程）
- 验收分项记录：程序检查 / macOS 实测 / Windows 实测 / 学科复核 / 纸样复核；不以单一"测试通过"代替
- 需求走 GitHub Issue，分支与 PR 关联 Issue，逐条验收后关闭
- 多 agent 并行规则（认领、分支隔离、接口先行、提交即 push）见 [GitHub 协作与开源发布方案](docs/GitHub协作与开源发布方案.md) 第 6 节
- 关键依赖（Electron、数据库驱动、PDF.js、KaTeX 等）版本在 M0 固定，目标值与实测值分开记录
- 学科内容判断（题意、标签、答案、评分、纸样效果）交给用户，agent 提供具体题号和原卷页供判断

## Superpowers 技能链

开发流程显式走 superpowers 技能：

- 需求澄清 → superpowers:brainstorming（遵循上层"沟通方式"：先给最合理方案，再问是否调整）
- 多步任务定方案 → superpowers:writing-plans
- 执行计划 → superpowers:executing-plans / superpowers:subagent-driven-development
- 写实现 → superpowers:test-driven-development（对应"每阶段先写会失败的测试或验收步骤"）
- 分支隔离 → superpowers:using-git-worktrees
- 声称完成前 → superpowers:verification-before-completion（对应"验证"一节）
- 合并收尾 → superpowers:requesting-code-review / superpowers:finishing-a-development-branch

本文档规则优先于技能默认行为；冲突时以本文为准。

## 授权与自动执行（2026-11-04 用户确认）

- 开发 agent 按 Issue 驱动自主循环，过程不打扰用户：拆目标 → 建 Issue → 分支 → 先写测试再实现 → 自测 → PR（证据+验收状态）→ 合并 → 下一条
- 预授权：本仓库常规 push、feature 分支合并 main，不再逐次询问
- 学科复核与纸样终验：agent 先对照原卷自查并给出具体题号、原卷页与判断建议，攒批集中提交用户确认
- Windows 实测无硬件环境时标"待补验"，注明原因与补验方式
- 工程决策（依赖选型、实现结构）agent 自主并记录理由；产品行为变更先改对应文档再改代码
- 仍属红线、需当次确认：公开发布安装包、修改密钥或环境配置、删除文件或目录、变更仓库可见性

## 数据与安全红线

- 真实题库、用户原件、AI 模型密钥不进代码、不进 commit、不进仓库、不进日志
- `research/pdfs/`（约 133MB 样本卷）已 gitignore，样本以 `research/PDF清单.md` 登记；确需随仓库分发时再定 LFS 或外部托管
- 自动化测试用固定响应模拟 AI；真实模型调用按当次授权，费用与上传范围单独确认
- 学生卷不得泄露答案：学生卷与教师卷由各自允许的内容字段生成，不靠隐藏答案元素
