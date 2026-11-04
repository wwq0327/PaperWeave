import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { clearApiKey, keyExists, loadApiKey, saveApiKey, type KeyStore } from "../../../src/main/ai-key";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "paperweave-key-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const store: KeyStore = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(`enc:${Buffer.from(value, "utf8").toString("base64")}`, "utf8"),
  decrypt: (data) => {
    const text = data.toString("utf8");
    if (!text.startsWith("enc:")) throw new Error("bad");
    return Buffer.from(text.slice(4), "base64").toString("utf8");
  },
};

test("密钥加密后单独存放，不明文入库", () => {
  const dir = tempDir();
  saveApiKey(dir, "  sk-secret-123  ", store);
  expect(keyExists(dir)).toBe(true);
  const raw = readFileSync(join(dir, "ai-key.bin"), "utf8");
  expect(raw).not.toContain("sk-secret-123");
  expect(loadApiKey(dir, store)).toBe("sk-secret-123");
});

test("安全存储不可用时拒绝保存", () => {
  const dir = tempDir();
  expect(() => saveApiKey(dir, "sk-secret", { ...store, isAvailable: () => false })).toThrow("安全存储");
  expect(keyExists(dir)).toBe(false);
});

test("空密钥拒绝保存，清除后不再存在", () => {
  const dir = tempDir();
  expect(() => saveApiKey(dir, "   ", store)).toThrow("不能为空");
  saveApiKey(dir, "sk-secret", store);
  clearApiKey(dir);
  expect(keyExists(dir)).toBe(false);
  expect(loadApiKey(dir, store)).toBeUndefined();
});

test("无法解密的密钥提示重新配置，而不是返回空值", () => {
  const dir = tempDir();
  saveApiKey(dir, "sk-secret", store);
  expect(() => loadApiKey(dir, { ...store, decrypt: () => { throw new Error("keychain"); } })).toThrow("重新配置");
});
