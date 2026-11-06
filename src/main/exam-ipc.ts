import { BrowserWindow, dialog, ipcMain } from "electron";
import { originalFileKind } from "../shared/ai";
import { isExamFileRole, type ExamDetailView, type ExamFileRecord, type ExamFileView, type OriginalFileRecord, type OriginalFileView } from "../shared/exam";
import type { Database } from "./database";
import { AttachmentStore } from "./attachments";
import { extractDocxText } from "./docx";
import { ExamStore } from "./exams";
import { Intake } from "./intake";
import { extractPdfText } from "./pdf-text";
import { QuestionBank } from "./question-bank";
import { prepareWholePaper } from "./whole-paper-prepare";
import { WholePaperIntake } from "./whole-paper-intake";
import { WholePaperStore, type WholePaperTask } from "./whole-paper-store";
import type { WholePaperTaskDetail, WholePaperTaskView } from "../shared/whole-paper-view";
import type { Classification } from "../shared/question";

const fileView = (file: OriginalFileRecord): OriginalFileView => ({
  id: file.id,
  sha256: file.sha256,
  originalName: file.originalName,
  size: file.size,
  createdAt: file.createdAt,
});
const examFileView = (file: ExamFileRecord): ExamFileView => ({ ...fileView(file), role: file.role });

/** 考试原件 IPC：文件选择与读取都在主进程完成，渲染进程只拿标识与字节。 */
export function registerExams(db: Database, root: string, currentWindow: () => BrowserWindow | undefined): void {
  const store = new ExamStore(db, root);
  const bank = new QuestionBank(db);
  const intake = new Intake(store, bank);
  const wholePaper = new WholePaperStore(db);
  const wholeIntake = new WholePaperIntake(db, wholePaper, intake, bank, store);
  const sourceKindOf = (task: WholePaperTask): "pdf" | "docx" => {
    const file = task.sourceFileId === undefined ? undefined : store.getExam(task.examId).files.find((entry) => entry.id === task.sourceFileId);
    return file === undefined ? "pdf" : originalFileKind(file.originalName);
  };
  const taskView = (task: WholePaperTask): WholePaperTaskView => ({
    id: task.id, sectionId: task.sectionId, revision: task.revision, sourceFileId: task.sourceFileId, sourceKind: sourceKindOf(task), createdAt: task.createdAt,
    emptyPages: task.state.plan.emptyPages,
    batches: task.state.plan.batches.map((batch, index) => ({ pages: batch.pages, status: task.state.batches[index].status, reviewBoundaryBefore: batch.reviewBoundaryBefore })),
  });
  const attachments = new AttachmentStore(root);
  const permitted = (event: Electron.IpcMainInvokeEvent) => {
    const win = currentWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("无权访问考试资料");
    return win;
  };
  const text = (value: unknown, name: string): string => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name}无效`);
    return value.trim();
  };
  const chooseFile = async (win: BrowserWindow, title: string, filterName: string, extensions: string[]): Promise<string | null> => {
    const result = await dialog.showOpenDialog(win, { title, properties: ["openFile"], filters: [{ name: filterName, extensions }] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  };
  const choosePaper = (win: BrowserWindow) => chooseFile(win, "选择原卷 PDF 或 DOCX", "原卷文件", ["pdf", "docx"]);
  const choosePdf = (win: BrowserWindow, title: string) => chooseFile(win, title, "PDF", ["pdf"]);
  const ownedWholeTask = (examId: unknown, taskId: unknown): WholePaperTask => {
    const id = text(examId, "考试标识");
    const task = wholePaper.get(text(taskId, "整卷任务"));
    if (task.examId !== id) throw new Error("整卷任务不属于该考试");
    return task;
  };

  ipcMain.handle("exam:list", (event) => {
    permitted(event);
    return store.listExams();
  });
  ipcMain.handle("exam:get", (event, examId: unknown): ExamDetailView => {
    permitted(event);
    const detail = store.getExam(text(examId, "考试标识"));
    return { ...detail, files: detail.files.map(examFileView) };
  });
  ipcMain.handle("exam:import", async (event, input: unknown) => {
    const win = permitted(event);
    const path = await choosePaper(win);
    if (path === null) return { status: "canceled" as const };
    const { file, ...result } = store.importPaper(input, path);
    return { status: "imported" as const, ...result, file: fileView(file) };
  });
  ipcMain.handle("exam:attach", async (event, examId: unknown, role: unknown) => {
    const win = permitted(event);
    const id = text(examId, "考试标识");
    if (!isExamFileRole(role)) throw new Error("文件角色无效");
    const path = await choosePdf(win, `选择${role === "answer" ? "答案" : role === "rubric" ? "评分细则" : role === "answer_sheet" ? "答题卡" : "原卷"} PDF`);
    if (path === null) return { status: "canceled" as const };
    const { file, ...result } = store.attachFile(id, role, path);
    return { status: "attached" as const, ...result, file: examFileView(file) };
  });
  ipcMain.handle("exam:addSection", (event, examId: unknown, title: unknown, subject: unknown) => {
    permitted(event);
    return store.addSection(text(examId, "考试标识"), title, subject);
  });
  ipcMain.handle("exam:fileData", (event, fileId: unknown) => {
    permitted(event);
    const { file, data } = store.readFile(text(fileId, "原卷文件"));
    return { file: fileView(file), data: new Uint8Array(data) };
  });
  ipcMain.handle("exam:questions", (event, examId: unknown) => {
    permitted(event);
    return store.listQuestions(text(examId, "考试标识"));
  });
  ipcMain.handle("exam:fileText", async (event, fileId: unknown) => {
    permitted(event);
    const { file, data } = store.readFile(text(fileId, "原卷文件"));
    if (originalFileKind(file.originalName) === "docx") {
      const extracted = extractDocxText(data);
      return { pages: extracted.units.map((unit) => ({ page: unit.unit, text: unit.text })), hasText: extracted.hasText };
    }
    return extractPdfText(new Uint8Array(data));
  });
  ipcMain.handle("wholePaper:prepare", async (event, examId: unknown, sectionId: unknown, fileId: unknown) => {
    permitted(event);
    return taskView(await prepareWholePaper(store, wholePaper, text(examId, "考试标识"), text(sectionId, "考试分部"), text(fileId, "原卷文件")));
  });
  ipcMain.handle("wholePaper:list", (event, examId: unknown) => {
    permitted(event);
    const id = text(examId, "考试标识");
    store.getExam(id);
    return wholePaper.list().filter((task) => task.examId === id).map((task) => taskView(wholePaper.get(task.id)));
  });
  ipcMain.handle("wholePaper:detail", (event, examId: unknown, taskId: unknown): WholePaperTaskDetail => {
    permitted(event);
    const task = ownedWholeTask(examId, taskId);
    return { ...taskView(task), results: task.state.batches.map((batch) => batch.result ?? null) };
  });
  ipcMain.handle("wholePaper:intakeCreate", (event, examId: unknown, taskId: unknown, classification: unknown) => {
    permitted(event);
    const task = ownedWholeTask(examId, taskId);
    if (typeof classification !== "object" || classification === null) throw new Error("整卷分类无效");
    return wholeIntake.create(task.id, classification as Classification);
  });
  ipcMain.handle("wholePaper:intakeList", (event, examId: unknown, taskId: unknown) => {
    permitted(event);
    return wholeIntake.list(ownedWholeTask(examId, taskId).id);
  });
  ipcMain.handle("wholePaper:intakeCoverage", (event, examId: unknown, taskId: unknown) => {
    permitted(event);
    return wholeIntake.coverage(ownedWholeTask(examId, taskId).id);
  });
  ipcMain.handle("wholePaper:intakeResolve", (event, examId: unknown, taskId: unknown, recordId: unknown, action: unknown) => {
    permitted(event);
    const id = text(recordId, "建档记录");
    if (action !== "skip" && action !== "revise" && action !== "resolve" && action !== "exclude") throw new Error("处理动作无效");
    const task = ownedWholeTask(examId, taskId);
    wholeIntake.resolve(task.id, id, action);
  });
  ipcMain.handle("wholePaper:intakeApprove", (event, examId: unknown, taskId: unknown, recordIds: unknown) => {
    permitted(event);
    if (!Array.isArray(recordIds) || recordIds.some((id) => typeof id !== "string")) throw new Error("待确认题目无效");
    const task = ownedWholeTask(examId, taskId);
    return wholeIntake.approve(task.id, recordIds as string[]);
  });
  ipcMain.handle("intake:save", (event, input: unknown) => {
    permitted(event);
    return intake.save(input);
  });
  ipcMain.handle("intake:saveFigure", (event, dataUrl: unknown) => {
    permitted(event);
    return attachments.saveDataUrl(dataUrl);
  });
  ipcMain.handle("question:createMaterial", (event, input: unknown) => {
    permitted(event);
    return bank.createMaterial(input);
  });
  ipcMain.handle("question:saveMaterialVersion", (event, materialId: unknown, input: unknown) => {
    permitted(event);
    return bank.saveMaterialVersion(text(materialId, "材料标识"), input);
  });
  ipcMain.handle("question:affectedByMaterial", (event, materialId: unknown) => {
    permitted(event);
    return bank.questionsAffectedByMaterial(text(materialId, "材料标识"));
  });
  ipcMain.handle("question:adoptMaterialVersion", (event, questionId: unknown, materialId: unknown, materialVersionId: unknown) => {
    permitted(event);
    return bank.adoptMaterialVersion(text(questionId, "题目标识"), text(materialId, "材料标识"), text(materialVersionId, "材料版本"));
  });
  ipcMain.handle("question:setMaterialStatus", (event, versionId: unknown, status: unknown) => {
    permitted(event);
    bank.setMaterialStatus(text(versionId, "材料版本"), status as never);
  });
}
