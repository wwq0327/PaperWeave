import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { Database } from "./database";
import { Basket } from "./basket";
import { Paper } from "./paper";
import { PaperFinalizer } from "./paper-finalization";
import { QuestionBank } from "./question-bank";
import { paperVolume, type PaperSnapshot } from "../shared/paper-layout";
import type { AnswerStatus, ReviewStatus } from "../shared/question";
import type { BeginFinalizationView, QuestionDetailView } from "../shared/paper-api";

/** 题库、题篮、组卷与定稿的 IPC 面；不暴露 SQL，所有通道校验发送方主窗口。 */
export function registerPaper(db: Database, currentWindow: () => BrowserWindow | undefined): void {
  const bank = new QuestionBank(db);
  const basket = new Basket(db);
  const papers = new Paper(db);
  const finalizer = new PaperFinalizer(db, async () => { throw new Error("组卷 PDF 由界面渲染"); });
  let pending: { id: string; paperId: string; parent: string; snapshot: PaperSnapshot; owner: number; student?: Buffer; teacher?: Buffer } | undefined;
  let busy = false;

  const permitted = (event: Electron.IpcMainInvokeEvent) => {
    const win = currentWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("无权访问组卷功能");
    return win;
  };
  const text = (value: unknown, name: string): string => {
    if (typeof value !== "string" || !value) throw new Error(`${name}无效`);
    return value;
  };
  const finalizeOptions = (value: unknown): { confirmAnswerGap: boolean } => {
    if (value === undefined) return { confirmAnswerGap: false };
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("定稿选项无效");
    const record = value as Record<string, unknown>;
    if (!Object.keys(record).every((key) => key === "confirmAnswerGap")) throw new Error("定稿选项包含未知字段");
    if (record.confirmAnswerGap !== undefined && typeof record.confirmAnswerGap !== "boolean") throw new Error("答案待补确认无效");
    return { confirmAnswerGap: record.confirmAnswerGap === true };
  };
  const requirePending = (event: Electron.IpcMainInvokeEvent, id: unknown) => {
    const win = permitted(event);
    if (!pending || text(id, "操作标识") !== pending.id || pending.owner !== event.sender.id) throw new Error("组卷定稿操作无效或已结束");
    return { win, operation: pending };
  };
  const finish = () => { pending = undefined; busy = false; };
  const pdf = (win: BrowserWindow) => win.webContents.printToPDF({ pageSize: "A4", preferCSSPageSize: true, printBackground: true, scale: 1 });

  ipcMain.handle("questionBank:search", (event, filter: unknown) => {
    permitted(event);
    return bank.searchQuestions(filter);
  });
  ipcMain.handle("questionBank:detail", (event, versionId: unknown): QuestionDetailView => {
    permitted(event);
    const version = bank.getQuestionVersion(text(versionId, "题目版本"));
    if (version === undefined) throw new Error("题目版本不存在");
    return {
      questionId: version.questionId,
      versionId: version.id,
      version: version.version,
      contentStatus: version.contentStatus,
      answerStatus: version.answerStatus,
      content: version.content,
      classification: bank.getQuestionClassification(version.questionId),
      materials: version.content.materials.map((ref) => {
        const material = bank.getMaterialVersion(ref.versionId);
        if (material === undefined) throw new Error(`材料「${ref.materialId}」缺失`);
        return { materialId: ref.materialId, versionId: ref.versionId, title: material.title, content: material.content, source: material.source, status: material.status };
      }),
    };
  });

  ipcMain.handle("question:setContentStatus", (event, versionId: unknown, status: unknown) => {
    permitted(event);
    bank.setContentStatus(text(versionId, "题目版本"), status as ReviewStatus);
  });
  ipcMain.handle("question:setAnswerStatus", (event, versionId: unknown, status: unknown) => {
    permitted(event);
    bank.setAnswerStatus(text(versionId, "题目版本"), status as AnswerStatus);
  });
  ipcMain.handle("question:setClassification", (event, questionId: unknown, classification: unknown) => {
    permitted(event);
    return bank.setClassification(text(questionId, "题目"), classification);
  });

  ipcMain.handle("basket:list", (event) => {
    permitted(event);
    return basket.listBasket();
  });
  ipcMain.handle("basket:add", (event, questionId: unknown, versionId: unknown, subQuestionId: unknown, confirm: unknown) => {
    permitted(event);
    if (subQuestionId !== null && typeof subQuestionId !== "string") throw new Error("小问标识无效");
    return basket.addToBasket(text(questionId, "题目标识"), text(versionId, "题目版本"), subQuestionId, confirm === true);
  });
  ipcMain.handle("basket:remove", (event, id: unknown) => {
    permitted(event);
    basket.removeBasketItem(text(id, "题篮项"));
  });
  ipcMain.handle("basket:clear", (event) => {
    permitted(event);
    basket.clearBasket();
  });

  ipcMain.handle("paper:list", (event) => {
    permitted(event);
    return papers.listPapers();
  });
  ipcMain.handle("paper:create", (event, input: unknown) => {
    permitted(event);
    return papers.createPaper(input as { title: string; stage: "小学" | "初中" | "高中"; subject: string; grade: string });
  });
  ipcMain.handle("paper:get", (event, paperId: unknown) => {
    permitted(event);
    return papers.getPaper(text(paperId, "试卷标识"));
  });
  ipcMain.handle("paper:addSection", (event, paperId: unknown, title: unknown) => {
    permitted(event);
    return papers.addSection(text(paperId, "试卷标识"), text(title, "小节标题"));
  });
  ipcMain.handle("paper:removeSection", (event, sectionId: unknown) => {
    permitted(event);
    papers.removeSection(text(sectionId, "小节标识"));
  });
  ipcMain.handle("paper:addBasketItem", (event, paperId: unknown, sectionId: unknown, basketItemId: unknown) => {
    permitted(event);
    return papers.addBasketItem(text(paperId, "试卷标识"), text(sectionId, "小节标识"), text(basketItemId, "题篮项"));
  });
  ipcMain.handle("paper:removeItem", (event, itemId: unknown) => {
    permitted(event);
    papers.removeItem(text(itemId, "题目标识"));
  });
  ipcMain.handle("paper:moveItem", (event, itemId: unknown, sectionId: unknown, position: unknown) => {
    permitted(event);
    papers.moveItem(text(itemId, "题目标识"), text(sectionId, "小节标识"), position as number);
  });
  ipcMain.handle("paper:setItemScore", (event, itemId: unknown, score: unknown) => {
    permitted(event);
    return papers.setItemScore(text(itemId, "题目标识"), score as number);
  });
  ipcMain.handle("paper:setItemBlankSpace", (event, itemId: unknown, blankSpace: unknown) => {
    permitted(event);
    return papers.setItemBlankSpace(text(itemId, "题目标识"), blankSpace as never);
  });
  ipcMain.handle("paper:setItemScoring", (event, itemId: unknown, scoring: unknown) => {
    permitted(event);
    return papers.setItemScoring(text(itemId, "题目标识"), scoring as never);
  });
  ipcMain.handle("paper:confirmScoreConflict", (event, itemId: unknown, key: unknown) => {
    permitted(event);
    return papers.confirmScoreConflict(text(itemId, "题目标识"), text(key, "分值冲突"));
  });
  ipcMain.handle("paper:listFinalizations", (event, paperId: unknown) => {
    permitted(event);
    return finalizer.listFinalizations(text(paperId, "试卷标识"));
  });

  ipcMain.handle("paper:checkFinalize", (event, paperId: unknown, options: unknown) => {
    permitted(event);
    return finalizer.check(text(paperId, "试卷标识"), finalizeOptions(options));
  });
  ipcMain.handle("paper:beginFinalize", async (event, paperId: unknown, options: unknown): Promise<BeginFinalizationView> => {
    const win = permitted(event);
    if (busy) throw new Error("正在生成组卷 PDF，请稍候");
    const checkOptions = finalizeOptions(options);
    const check = finalizer.check(text(paperId, "试卷标识"), checkOptions);
    if (!check.ready) return { status: "blocked", check: { ready: check.ready, blockers: check.blockers, notices: check.notices, references: check.references } };
    const choice = await dialog.showOpenDialog(win, { title: "选择组卷双卷保存位置", properties: ["openDirectory", "createDirectory"] });
    if (choice.canceled || !choice.filePaths[0]) return { status: "canceled" };
    const prepared = finalizer.prepare(text(paperId, "试卷标识"), choice.filePaths[0], checkOptions);
    let student;
    try {
      student = paperVolume(prepared.snapshot, "student");
    } catch (error) {
      finalizer.abort(prepared.id);
      throw error;
    }
    pending = { id: prepared.id, paperId: prepared.snapshot.paper.id, parent: choice.filePaths[0], snapshot: prepared.snapshot, owner: event.sender.id };
    busy = true;
    return { status: "ready", id: prepared.id, student };
  });
  ipcMain.handle("paper:captureStudent", async (event, id: unknown) => {
    const { win, operation } = requirePending(event, id);
    if (operation.student) throw new Error("学生卷已生成");
    operation.student = await pdf(win);
  });
  ipcMain.handle("paper:teacherVolume", (event, id: unknown) => {
    const { operation } = requirePending(event, id);
    if (!operation.student) throw new Error("请先生成学生卷");
    return paperVolume(operation.snapshot, "teacher");
  });
  ipcMain.handle("paper:captureTeacher", async (event, id: unknown) => {
    const { win, operation } = requirePending(event, id);
    if (!operation.student) throw new Error("请先生成学生卷");
    if (operation.teacher) throw new Error("教师卷已生成");
    const teacher = await pdf(win);
    const paths = await finalizer.stagePreview(operation.id, operation.parent, operation.student, teacher);
    operation.teacher = teacher;
    const openErrors = await Promise.all([shell.openPath(paths.studentPath), shell.openPath(paths.teacherPath)]);
    return { ...paths, openErrors };
  });
  ipcMain.handle("paper:confirmFinalize", async (event, id: unknown) => {
    const { operation } = requirePending(event, id);
    if (!operation.student || !operation.teacher) throw new Error("请先生成双卷预览");
    try {
      const record = await finalizer.complete(operation.id, operation.paperId, operation.parent, operation.snapshot, operation.student, operation.teacher);
      await finalizer.clearPreview(operation.id, operation.parent).catch(() => undefined);
      return { record };
    } finally {
      finish();
    }
  });
  ipcMain.handle("paper:cancelFinalize", async (event, id: unknown) => {
    const { operation } = requirePending(event, id);
    finalizer.abort(operation.id);
    await finalizer.clearPreview(operation.id, operation.parent).catch(() => undefined);
    finish();
  });
  ipcMain.handle("paper:reprint", async (event, id: unknown) => {
    permitted(event);
    const paths = await finalizer.reprint(text(id, "定稿标识"));
    const openErrors = await Promise.all([shell.openPath(paths.studentPath), shell.openPath(paths.teacherPath)]);
    return { ...paths, openErrors };
  });
}
