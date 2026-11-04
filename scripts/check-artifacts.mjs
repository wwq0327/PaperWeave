import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const infoPlist = path.join("out", "PaperWeave-darwin-arm64", "PaperWeave.app", "Contents", "Info.plist");
const checks = [
  { label: "macOS 应用包信息", file: infoPlist },
  { label: "macOS dmg", dir: path.join("out", "make", "dmg", "arm64"), ext: ".dmg" },
  { label: "macOS zip", dir: path.join("out", "make", "zip", "darwin", "arm64"), ext: ".zip" },
  { label: "Windows x64 zip", dir: path.join("out", "make", "zip", "win32", "x64"), ext: ".zip" },
];

const artifacts = [];
const missing = [];

for (const entry of checks) {
  if (entry.file) {
    if (existsSync(entry.file) && statSync(entry.file).size > 0) artifacts.push(entry.file);
    else missing.push(`${entry.label}: ${entry.file}`);
    continue;
  }
  const matches = existsSync(entry.dir) ? readdirSync(entry.dir).filter((name) => name.endsWith(entry.ext)) : [];
  if (matches.length === 1) artifacts.push(path.join(entry.dir, matches[0]));
  else missing.push(`${entry.label}: ${entry.dir} 下 ${entry.ext} 数量=${matches.length}（预期 1）`);
}

if (missing.length === 0) {
  const plistVersion = execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", infoPlist], { encoding: "utf8" }).trim();
  if (plistVersion !== version) missing.push(`Info.plist 版本=${plistVersion}，package.json=${version}`);

  const dmg = artifacts.find((file) => file.endsWith(".dmg"));
  if (dmg && !path.basename(dmg).includes(version)) missing.push(`dmg 文件名不含版本 ${version}：${dmg}`);

  const darwinZip = artifacts.find((file) => file.includes(`${path.sep}darwin${path.sep}`));
  const darwinEntries = execFileSync("unzip", ["-l", darwinZip], { encoding: "utf8" });
  if (!darwinEntries.includes("PaperWeave.app/")) missing.push(`macOS zip 缺少 PaperWeave.app：${darwinZip}`);

  const winZip = artifacts.find((file) => file.includes(`${path.sep}win32${path.sep}`));
  const winEntries = execFileSync("unzip", ["-l", winZip], { encoding: "utf8" });
  if (!winEntries.includes("PaperWeave.exe")) missing.push(`Windows zip 缺少 PaperWeave.exe：${winZip}`);
  if (!winEntries.includes("resources/app/package.json")) missing.push(`Windows zip 缺少 resources/app/package.json：${winZip}`);
  if (!path.basename(winZip).includes(version)) missing.push(`Windows zip 文件名不含版本 ${version}：${winZip}`);

  const zipVersion = (zip, suffix) => {
    const entry = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").find((name) => name.endsWith(suffix));
    if (!entry) return undefined;
    return JSON.parse(execFileSync("unzip", ["-p", zip, entry], { encoding: "utf8" })).version;
  };
  const winVersion = zipVersion(winZip, "resources/app/package.json");
  if (winVersion !== version) missing.push(`Windows zip 内版本=${winVersion}，package.json=${version}`);
  const darwinVersion = zipVersion(darwinZip, "Contents/Resources/app/package.json");
  if (darwinVersion !== version) missing.push(`macOS zip 内版本=${darwinVersion}，package.json=${version}`);
}

if (missing.length > 0) {
  console.error("产物缺失：");
  for (const message of missing) console.error(`  ✗ ${message}`);
  process.exit(1);
}

const rows = artifacts.map((file) => ({
  产物: file,
  字节数: statSync(file).size,
  SHA256: createHash("sha256").update(readFileSync(file)).digest("hex"),
}));
console.table(rows);

if (process.argv.includes("--record")) {
  const record = {
    product: "PaperWeave",
    version,
    generatedAt: new Date().toISOString(),
    files: rows.map((row) => ({ path: row.产物, bytes: row.字节数, sha256: row.SHA256 })),
  };
  writeFileSync(path.join("docs", "安装包清单.json"), `${JSON.stringify(record, null, 2)}\n`);
  console.log("产物清单已写入 docs/安装包清单.json");
}
console.log("产物检查通过");
