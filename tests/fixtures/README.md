# 测试夹具

本目录的 PDF 与 Markdown 夹具均为**自制合成样本**，不含真实试卷、题库或学生数据，只用于自动化验证。

| 文件 | 内容 | 生成方式 |
|---|---|---|
| `text.pdf` | 一页英文文字：Question 1 / Answer: 4 | macOS `cupsfilter -m application/pdf` 从纯文本生成 |
| `two-pages.pdf` | 两页文字，用于页码顺序检查 | 同上，原文用换页符分出两页 |
| `blank.pdf` | 一页无文字，模拟扫描件无文字层 | 同上，原文只有空白 |
| `tiku-mini/` | 自制 Tiku 目录：两道题、一段材料、一张 1×1 PNG | 手写 Markdown 与 base64 PNG，不含真实题库 |

重新生成时可在 macOS 上用 `cupsfilter` 从纯文本输出 PDF。真实试卷样本按项目规则留在 `research/pdfs/`（不入库），不放进本目录。
