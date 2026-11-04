import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PendingOperation } from "./pdf-journal";

const expected = new Set(["学生卷.pdf", "教师答案卷.pdf"]);

async function entries(path: string): Promise<string[] | undefined> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 启动时清理未完成的双卷操作；只删除内容符合预期的暂存目录，已完成目录一律保留。 */
export async function recoverPendingOperations(operations: PendingOperation[]): Promise<{ cleared: string[]; kept: PendingOperation[] }> {
  const cleared: string[] = [];
  const kept: PendingOperation[] = [];
  for (const operation of operations) {
    const pending = join(operation.parent, `.paperweave-${operation.id}.pending`);
    const pendingNames = await entries(pending);
    if (pendingNames && !pendingNames.every((name) => expected.has(name))) {
      kept.push(operation);
      continue;
    }
    if (pendingNames) await rm(pending, { recursive: true, force: true });
    cleared.push(operation.id);
  }
  return { cleared, kept };
}
