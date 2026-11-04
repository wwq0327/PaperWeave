import { describe, expect, it } from "vitest";
import { parseBackupManifest } from "../../../src/shared/backup";

const sha = "a".repeat(64);
const valid = {
  format: "paperweave-backup",
  formatVersion: 1,
  dataVersion: 7,
  appVersion: "1.0.0",
  createdAt: "2026-11-05T06:25:30.000Z",
  totalBytes: 1234,
  files: [
    { path: "database/paperweave.sqlite", size: 1000, sha256: sha },
    { path: "originals/" + sha + ".pdf", size: 234, sha256: sha },
  ],
};

describe("备份清单", () => {
  it("接受合法清单并返回规范化对象", () => {
    const manifest = parseBackupManifest(valid, 7);
    expect(manifest.files).toHaveLength(2);
    expect(manifest.totalBytes).toBe(1234);
    expect(manifest.dataVersion).toBe(7);
  });

  it("拒绝未知格式、格式版本与高于当前支持的数据版本", () => {
    expect(() => parseBackupManifest({ ...valid, format: "other" }, 7)).toThrow("不是 PaperWeave 备份");
    expect(() => parseBackupManifest({ ...valid, formatVersion: 2 }, 7)).toThrow("备份格式版本不受支持");
    expect(() => parseBackupManifest({ ...valid, dataVersion: 8 }, 7)).toThrow("备份数据版本高于当前应用");
  });

  it("拒绝越界、绝对、重复或含反斜杠的文件路径", () => {
    const withPath = (path: string) => ({ ...valid, files: [{ path, size: 1234, sha256: sha }] });
    expect(() => parseBackupManifest(withPath("../outside.pdf"), 7)).toThrow("备份文件路径无效");
    expect(() => parseBackupManifest(withPath("/etc/passwd"), 7)).toThrow("备份文件路径无效");
    expect(() => parseBackupManifest(withPath("originals\\a.pdf"), 7)).toThrow("备份文件路径无效");
    expect(() => parseBackupManifest(withPath("a/./b.pdf"), 7)).toThrow("备份文件路径无效");
    expect(() => parseBackupManifest({ ...valid, files: [valid.files[0], valid.files[0]] }, 7)).toThrow("备份文件路径重复");
  });

  it("拒绝大小、校验值与总字节数不一致的清单", () => {
    expect(() => parseBackupManifest({ ...valid, files: [{ ...valid.files[0], size: -1 }], totalBytes: 1000 }, 7)).toThrow("备份文件大小无效");
    expect(() => parseBackupManifest({ ...valid, files: [{ ...valid.files[0], sha256: "xyz" }] }, 7)).toThrow("备份文件校验值无效");
    expect(() => parseBackupManifest({ ...valid, totalBytes: 1 }, 7)).toThrow("备份总字节数不一致");
  });

  it("拒绝缺失或非法元数据", () => {
    expect(() => parseBackupManifest({ ...valid, createdAt: "昨天" }, 7)).toThrow("备份创建时间无效");
    expect(() => parseBackupManifest({ ...valid, appVersion: " " }, 7)).toThrow("备份应用版本无效");
    expect(() => parseBackupManifest({ ...valid, dataVersion: 1.5 }, 7)).toThrow("备份数据版本无效");
    expect(() => parseBackupManifest(null, 7)).toThrow("备份清单缺失");
  });

  it("拒绝清单中缺少数据库快照或混入密钥文件", () => {
    expect(() => parseBackupManifest({ ...valid, files: [valid.files[1]] }, 7)).toThrow("备份缺少数据库快照");
    expect(() => parseBackupManifest({ ...valid, files: [...valid.files, { path: "ai-key.bin", size: 1, sha256: sha }], totalBytes: 1235 }, 7)).toThrow("备份不得包含密钥");
    expect(() => parseBackupManifest({ ...valid, files: [...valid.files, { path: "database/paperweave.sqlite-wal", size: 1, sha256: sha }], totalBytes: 1235 }, 7)).toThrow("备份文件路径无效");
  });
});
