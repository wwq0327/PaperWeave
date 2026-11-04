import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 由主进程注入 Electron safeStorage；单测使用内存假实现。 */
export interface KeyStore {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(data: Buffer): string;
}

const keyFile = (root: string) => join(root, "ai-key.bin");

export function keyExists(root: string): boolean {
  return existsSync(keyFile(root));
}

export function saveApiKey(root: string, key: string, store: KeyStore): void {
  const value = key.trim();
  if (!value) throw new Error("密钥不能为空");
  if (value.length > 500) throw new Error("密钥过长，请检查是否粘贴了其他内容");
  if (!store.isAvailable()) throw new Error("系统安全存储不可用，未保存密钥");
  writeFileSync(keyFile(root), store.encrypt(value), { mode: 0o600 });
}

export function loadApiKey(root: string, store: KeyStore): string | undefined {
  if (!keyExists(root)) return undefined;
  try {
    return store.decrypt(readFileSync(keyFile(root)));
  } catch {
    throw new Error("模型密钥无法解密，请重新配置密钥");
  }
}

export function clearApiKey(root: string): void {
  rmSync(keyFile(root), { force: true });
}
