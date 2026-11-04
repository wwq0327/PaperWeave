import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function pdfPairPaths(parent: string, operationId: string) {
  return {
    pending: join(parent, `.paperweave-${operationId}.pending`),
    result: join(parent, `拾题成卷-样张-${operationId}`),
  };
}

/** 两份样张作为一个目录发布：任一写入或校验失败时，不出现完整目录。 */
export async function writePdfPair(parent: string, operationId: string, student: Buffer, teacher: Buffer, io = { mkdir, readFile, rename, rm, writeFile }): Promise<string> {
  const validPdf = (data: Buffer) => data.length >= 100 && data.subarray(0, 5).equals(Buffer.from("%PDF-")) && data.subarray(-1024).includes(Buffer.from("%%EOF"));
  if (!validPdf(student) || !validPdf(teacher)) throw new Error("双份 PDF 必须都生成并校验成功");
  if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new Error("操作标识无效");
  const { pending, result } = pdfPairPaths(parent, operationId);
  try {
    const existingStudent = await io.readFile(join(result, "学生卷.pdf"));
    const existingTeacher = await io.readFile(join(result, "教师答案卷.pdf"));
    if (!existingStudent.equals(student) || !existingTeacher.equals(teacher)) throw new Error("操作标识已用于不同内容");
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let created = false;
  try {
    await io.mkdir(pending);
    created = true;
    const studentPath = join(pending, "学生卷.pdf");
    const teacherPath = join(pending, "教师答案卷.pdf");
    await io.writeFile(studentPath, student, { flag: "wx" });
    await io.writeFile(teacherPath, teacher, { flag: "wx" });
    if (!(await io.readFile(studentPath)).equals(student) || !(await io.readFile(teacherPath)).equals(teacher)) throw new Error("PDF 写入校验失败");
    // 暂存和目标同目录，目录重命名后两个文件才同时可见。
    await io.rename(pending, result);
    return result;
  } catch (error) {
    if (created) await io.rm(pending, { recursive: true, force: true });
    throw error;
  }
}
