import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { AI_LIMITS, isAiDraft, normalizeAiInput } from "../shared/ai";
import { normalizeAiConfig, parseAiConfig } from "../shared/ai-config";
import { Database } from "./database";
import { fakeAiDraft, type FakeScenario } from "./ai-fake";
import { clearApiKey, keyExists, loadApiKey, saveApiKey, type KeyStore } from "./ai-key";
import { requestAiDraft } from "./ai-provider";
import { extractPdfText } from "./pdf-text";
import { QuestionBank } from "./question-bank";
import { ExamStore } from "./exams";
import { WholePaperStore } from "./whole-paper-store";
import { WholePaperRunner } from "../shared/whole-paper-runner";

const configKey = "ai.config";
const maxPdfBytes = 50 * 1024 * 1024;
const requestIdPattern = /^[a-zA-Z0-9-]{8,64}$/;
const fakeScenarios = new Set(["ok", "invalid", "malicious", "timeout", "late", "late-success"]);

export function registerAi(db: Database, root: string, currentWindow: () => BrowserWindow | undefined): void {
  const bank = new QuestionBank(db);
  const store: KeyStore = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (data) => safeStorage.decryptString(data),
  };
  const permitted = (event: Electron.IpcMainInvokeEvent) => {
    const win = currentWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("无权访问 AI 设置");
  };
  const publicConfig = () => ({ ...parseAiConfig(db.getSetting(configKey)), hasKey: keyExists(root) });
  const inFlight = new Map<string, AbortController>();
  const wholeInFlight = new Map<string, AbortController>();
  const wholeTasks = new WholePaperStore(db);
  const exams = new ExamStore(db, root);
  const choosePdf = async () => {
    const win = currentWindow();
    if (!win) throw new Error("窗口已关闭");
    const result = await dialog.showOpenDialog(win, { title: "选择原卷 PDF", properties: ["openFile"], filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const path = result.filePaths[0];
    const file = await open(path, "r");
    let data: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size === 0 || info.size > maxPdfBytes) throw new Error("请选择不超过 50 MiB 的有效 PDF");
      data = Buffer.alloc(info.size);
      const { bytesRead } = await file.read(data, 0, data.length, 0);
      if (bytesRead !== data.length) throw new Error("PDF 读取不完整，请重试");
    } finally {
      await file.close();
    }
    return { name: basename(path), data };
  };

  ipcMain.handle("ai:getConfig", (event) => {
    permitted(event);
    return publicConfig();
  });

  ipcMain.handle("ai:saveConfig", (event, value: unknown) => {
    permitted(event);
    const config = normalizeAiConfig(value);
    db.setSetting(configKey, JSON.stringify(config));
    return publicConfig();
  });

  ipcMain.handle("ai:saveKey", (event, value: unknown) => {
    permitted(event);
    if (typeof value !== "string") throw new Error("密钥格式无效");
    saveApiKey(root, value, store);
    return publicConfig();
  });

  ipcMain.handle("ai:clearKey", (event) => {
    permitted(event);
    clearApiKey(root);
    return publicConfig();
  });

  ipcMain.handle("ai:draft", async (event, requestId: unknown, value: unknown) => {
    permitted(event);
    if (typeof requestId !== "string" || !requestIdPattern.test(requestId)) throw new Error("请求标识无效");
    if (inFlight.has(requestId)) throw new Error("重复的 AI 请求");
    const checked = normalizeAiInput(value);
    if (!checked.ok) throw new Error(checked.error);
    const context = checked.input.context;
    const tagCandidates = context ? bank.knowledgePointCandidates(context.stage, context.subject, AI_LIMITS.tagCount) : [];

    const scenario = process.env.PAPERWEAVE_AI_FAKE as FakeScenario | undefined;
    // 固定响应只用于未打包的开发/自动化运行，避免安装包被环境变量绕过真实调用。
    const fake = !app.isPackaged && scenario && fakeScenarios.has(scenario) ? scenario : undefined;
    const config = parseAiConfig(db.getSetting(configKey));
    const apiKey = fake ? "" : loadApiKey(root, store);
    if (!fake && !apiKey) throw new Error("尚未配置模型密钥，请先在 AI 设置中保存");

    const controller = new AbortController();
    inFlight.set(requestId, controller);
    try {
      const result = fake
        ? await fakeAiDraft(fake, checked.input, controller.signal)
        : await requestAiDraft(config, apiKey as string, checked.input, controller.signal, undefined, tagCandidates);
      // 取消时即使响应已经到达也丢弃，避免迟到结果覆盖人工编辑。
      if (controller.signal.aborted) throw new Error("已取消");
      if (!isAiDraft(result)) throw new Error("模型返回格式无法解析，请重试或手工录入");
      return { draft: result, tagCandidates };
    } finally {
      if (inFlight.get(requestId) === controller) inFlight.delete(requestId);
    }
  });

  ipcMain.handle("ai:runWholePaper", async (event, examId: unknown, taskId: unknown, revision: unknown, confirmedConfig: unknown) => {
    permitted(event);
    if (typeof examId !== "string" || typeof taskId !== "string" || !Number.isSafeInteger(revision)) throw new Error("整卷任务参数无效");
    if (wholeInFlight.has(taskId)) throw new Error("整卷任务正在执行");
    let task = wholeTasks.get(taskId);
    if (task.examId !== examId) throw new Error("整卷任务不属于该考试");
    if (task.revision !== revision) throw new Error("任务已变化，请重新确认发送范围");
    const config = parseAiConfig(db.getSetting(configKey));
    if (typeof confirmedConfig !== "object" || confirmedConfig === null || (confirmedConfig as Record<string, unknown>).baseUrl !== config.baseUrl || (confirmedConfig as Record<string, unknown>).textModel !== config.textModel) throw new Error("模型配置已变化，请重新确认");
    const exam = exams.getExam(examId);
    const section = exam.sections.find((item) => item.id === task.sectionId);
    if (!section) throw new Error("考试分部不存在");
    const context = { stage: exam.exam.stage, subject: section.subject || exam.exam.subject, grade: exam.exam.grade, questionType: "" };
    const tagCandidates = bank.knowledgePointCandidates(context.stage, context.subject, AI_LIMITS.tagCount);
    const scenario = process.env.PAPERWEAVE_AI_FAKE as FakeScenario | undefined;
    const fake = !app.isPackaged && scenario && fakeScenarios.has(scenario) ? scenario : undefined;
    const apiKey = fake ? "" : loadApiKey(root, store);
    if (!fake && !apiKey) throw new Error("尚未配置模型密钥，请先在 AI 设置中保存");
    const controller = new AbortController();
    wholeInFlight.set(taskId, controller);
    try {
      const runner = new WholePaperRunner(async (state) => { task = wholeTasks.save(task.id, task.revision, state); }, async (batch, signal) => {
        const checked = normalizeAiInput({ mode: "text", text: batch.text, pages: batch.pages, sourceKind: batch.sourceKind, context });
        if (!checked.ok) throw new Error(checked.error);
        const result = fake ? await fakeAiDraft(fake, checked.input, signal) : await requestAiDraft(config, apiKey as string, checked.input, signal, undefined, tagCandidates);
        if (result.questions.some((question) => !batch.pages.includes(question.page))) throw new Error("模型返回页码不属于本批");
        return result;
      });
      await runner.run(task.state, controller.signal, true);
    } finally {
      if (wholeInFlight.get(taskId) === controller) wholeInFlight.delete(taskId);
    }
  });

  ipcMain.handle("ai:cancelWholePaper", (event, taskId: unknown) => {
    permitted(event);
    if (typeof taskId !== "string") return false;
    const controller = wholeInFlight.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  });

  ipcMain.handle("ai:cancel", (event, requestId: unknown) => {
    permitted(event);
    if (typeof requestId !== "string") return false;
    const controller = inFlight.get(requestId);
    if (!controller) return false;
    controller.abort();
    inFlight.delete(requestId);
    return true;
  });

  ipcMain.handle("ai:extractPdf", async (event) => {
    permitted(event);
    const picked = await choosePdf();
    if (!picked) return null;
    const extracted = await extractPdfText(new Uint8Array(picked.data));
    return { name: picked.name, ...extracted };
  });

  ipcMain.handle("ai:loadPdf", async (event) => {
    permitted(event);
    const picked = await choosePdf();
    if (!picked) return null;
    const extracted = await extractPdfText(new Uint8Array(picked.data));
    return { name: picked.name, data: new Uint8Array(picked.data), ...extracted };
  });
}
