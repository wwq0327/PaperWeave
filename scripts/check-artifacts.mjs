import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const checks = [
  {
    label: "macOS 应用包信息",
    file: path.join("out", "PaperWeave-darwin-arm64", "PaperWeave.app", "Contents", "Info.plist"),
  },
  {
    label: "macOS zip",
    dir: path.join("out", "make", "zip", "darwin", "arm64"),
    ext: ".zip",
  },
  {
    label: "Windows x64 zip",
    dir: path.join("out", "make", "zip", "win32", "x64"),
    ext: ".zip",
  },
];

const artifacts = [];
const missing = [];

for (const c of checks) {
  if (c.file) {
    if (existsSync(c.file) && statSync(c.file).size > 0) {
      artifacts.push(c.file);
    } else {
      missing.push(`${c.label}: ${c.file}`);
    }
  } else {
    const matches = existsSync(c.dir)
      ? readdirSync(c.dir).filter((f) => f.endsWith(c.ext))
      : [];
    if (matches.length === 1) {
      artifacts.push(path.join(c.dir, matches[0]));
    } else {
      missing.push(`${c.label}: ${c.dir} 下 ${c.ext} 数量=${matches.length}（预期 1）`);
    }
  }
}

if (missing.length > 0) {
  console.error("产物缺失：");
  for (const m of missing) console.error("  ✗ " + m);
  process.exit(1);
}

console.table(artifacts.map((p) => ({ 产物: p, 字节数: statSync(p).size })));
console.log("产物检查通过");
