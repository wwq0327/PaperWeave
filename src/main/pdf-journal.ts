export interface PendingOperation {
  id: string;
  parent: string;
}

const idPattern = /^[a-f0-9-]{36}$/;

/** 数据库里的操作日志只接受本应用写入的结构，坏数据视为空。 */
export function parseJournal(raw: string | undefined): PendingOperation[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((x): x is PendingOperation =>
      typeof x === "object" && x !== null &&
      typeof (x as PendingOperation).id === "string" && idPattern.test((x as PendingOperation).id) &&
      typeof (x as PendingOperation).parent === "string" && (x as PendingOperation).parent.length > 0);
  } catch {
    return [];
  }
}

export function addOperation(list: PendingOperation[], operation: PendingOperation): PendingOperation[] {
  return [...list.filter((item) => item.id !== operation.id), operation];
}

export function removeOperation(list: PendingOperation[], id: string): PendingOperation[] {
  return list.filter((item) => item.id !== id);
}
