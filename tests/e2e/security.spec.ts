import { test, expect, _electron as electron, type Page } from "@playwright/test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const entry = path.resolve(".vite/build/main.cjs");
const preload = path.resolve(".vite/build/preload.cjs");

function launch(dir: string, fake = "ok") {
  return electron.launch({
    args: [entry, `--user-data-dir=${dir}`],
    env: { ...process.env, PAPERWEAVE_AI_FAKE: fake } as Record<string, string>,
  });
}
function tempDir() { return mkdtempSync(path.join(tmpdir(), "paperweave-security-")); }

async function closeApp(app: Awaited<ReturnType<typeof electron.launch>>) {
  const process = app.process();
  const exited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
}

function filesContaining(root: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try { if (readFileSync(full).includes(Buffer.from(needle))) hits.push(full); } catch { /* 运行中的缓存文件可能不可读，跳过 */ }
      }
    }
  };
  walk(root);
  return hits;
}

async function runAiAndSave(window: Page) {
  await window.getByLabel(/待处理文字/).fill("安全基线：这段文字进入草稿");
  await window.getByLabel(/原卷页码/).fill("2");
  await window.getByRole("button", { name: "生成 AI 草稿…" }).click();
  await window.getByRole("region", { name: "发送前确认" }).getByRole("button", { name: "确认发送并生成草稿" }).click();
  await expect(window.getByRole("heading", { name: "待核草稿（2 题）" })).toBeVisible();
  await window.getByRole("button", { name: "全部采纳" }).click();
  await window.getByRole("button", { name: "保存草稿" }).click();
  await expect(window.getByText("草稿已保存到本机。", { exact: false })).toBeVisible();
}

test("渲染进程无 Node、隔离与沙箱生效，跨窗口调用被拒绝", async () => {
  const dir = tempDir();
  const app = await launch(dir);
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { name: "编辑草稿" })).toBeVisible();

    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const current = BrowserWindow.getAllWindows()[0];
      const value = (current.webContents as unknown as {
        getLastWebPreferences: () => {
          contextIsolation: boolean;
          sandbox: boolean;
          nodeIntegration: boolean;
          nodeIntegrationInSubFrames?: boolean;
          webSecurity: boolean;
        };
      }).getLastWebPreferences();
      return {
        contextIsolation: value.contextIsolation,
        sandbox: value.sandbox,
        nodeIntegration: value.nodeIntegration,
        nodeIntegrationInSubFrames: value.nodeIntegrationInSubFrames,
        webSecurity: value.webSecurity,
      };
    });
    expect(prefs).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true });

    const probe = await window.evaluate(() => {
      const w = window as unknown as Record<string, unknown> & { paperweave: Record<string, unknown> };
      return {
        globals: ["process", "require", "module", "ipcRenderer", "Buffer", "electron"].map((name) => `${name}:${typeof w[name]}`),
        keys: Object.keys(w.paperweave).sort(),
      };
    });
    expect(probe.globals).toEqual(["process:undefined", "require:undefined", "module:undefined", "ipcRenderer:undefined", "Buffer:undefined", "electron:undefined"]);
    expect(probe.keys).toEqual([
      "addBasketItemToPaper", "addExamSection", "addPaperSection", "addToBasket", "adoptMaterialVersion", "applyImports", "attachExamFile", "beginPaperFinalize", "beginPdfPair", "cancelAiDraft", "cancelPaperFinalize", "cancelPdfPair", "cancelWholePaper", "capturePaperStudent", "capturePaperTeacher", "captureStudentPdf", "checkPaperFinalize", "chooseBackupDestination", "chooseBackupSource", "chooseImage", "clearAiKey", "clearBasket", "confirmPaperFinalize", "confirmPaperScoreConflict", "correctImport", "createBackup", "createMaterial", "createPaper", "createWholePaperIntake", "exportPdf", "extractPdfText", "finishPdfPair", "generateAiDraft", "getAiConfig", "getExam", "getExamFile", "getExamFileText", "getImage", "getPaper", "getPaperTeacherVolume", "getQuestionDetail", "getRuntimeVersions", "getWholePaperDetail", "importExam", "listBasket", "listExamQuestions", "listExams", "listImportBatches", "listPaperFinalizations", "listPapers", "listWholePaper", "listWholePaperIntakes", "loadDraft", "loadPdfForImages", "movePaperItem", "platform", "prepareWholePaper", "questionsAffectedByMaterial", "removeBasketItem", "removePaperItem", "removePaperSection", "reopenPaperPreview", "reprintPaper", "resolveWholePaperIntake", "restoreBackup", "runWholePaper", "saveAiConfig", "saveAiKey", "saveDraft", "saveIntake", "saveIntakeFigure", "saveMaterialVersion", "scanImports", "searchQuestions", "setMaterialStatus", "setPaperItemBlankSpace", "setPaperItemScore", "setPaperItemScoring", "setQuestionAnswerStatus", "setQuestionClassification", "setQuestionContentStatus", "updatePaperItemVersion",
    ]);

    const denied = await app.evaluate(async ({ BrowserWindow }, preloadPath) => {
      const other = new BrowserWindow({
        show: false,
        webPreferences: { preload: preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      try {
        await other.loadURL("data:text/html,<html><body>probe</body></html>");
        return await other.webContents.executeJavaScript(`(async () => {
          const bridge = window.paperweave;
          const attempt = (fn) => fn().then(() => "resolved", (error) => String(error));
          return [
            await attempt(() => bridge.saveDraft({ version: 2, blocks: [], teacherAnswer: "" })),
            await attempt(() => bridge.getRuntimeVersions()),
            await attempt(() => bridge.getImage("a".repeat(64))),
            await attempt(() => bridge.searchQuestions({})),
            await attempt(() => bridge.listBasket()),
            await attempt(() => bridge.getPaper("00000000-0000-0000-0000-000000000000")),
            await attempt(() => bridge.beginPaperFinalize("00000000-0000-0000-0000-000000000000")),
            await attempt(() => bridge.listExams()),
            await attempt(() => bridge.importExam({})),
            await attempt(() => bridge.listExamQuestions("00000000-0000-0000-0000-000000000000")),
            await attempt(() => bridge.saveIntake({})),
            await attempt(() => bridge.saveIntakeFigure("data:image/png;base64,AA==")),
            await attempt(() => bridge.createMaterial({})),
            await attempt(() => bridge.setMaterialStatus("missing", "approved")),
            await attempt(() => bridge.scanImports("tiku")),
            await attempt(() => bridge.applyImports({ scanId: "x", rows: [] })),
            await attempt(() => bridge.listImportBatches()),
            await attempt(() => bridge.setQuestionContentStatus("missing", "approved")),
            await attempt(() => bridge.setQuestionAnswerStatus("missing", "approved")),
            await attempt(() => bridge.setQuestionClassification("missing", {})),
            await attempt(() => bridge.getExamFileText("missing")),
            await attempt(() => bridge.prepareWholePaper("missing", "missing", "missing")),
            await attempt(() => bridge.listWholePaper("missing")),
            await attempt(() => bridge.chooseBackupDestination()),
            await attempt(() => bridge.createBackup()),
            await attempt(() => bridge.chooseBackupSource()),
            await attempt(() => bridge.restoreBackup()),
            await attempt(() => bridge.runWholePaper("missing", "missing", 1, {})),
            await attempt(() => bridge.cancelWholePaper("missing")),
            await attempt(() => bridge.getWholePaperDetail("missing", "missing")),
            await attempt(() => bridge.createWholePaperIntake("missing", "missing", {})),
            await attempt(() => bridge.listWholePaperIntakes("missing", "missing")),
            await attempt(() => bridge.resolveWholePaperIntake("missing", "missing", "missing", "skip")),
          ];
        })()`);
      } finally {
        other.destroy();
      }
    }, preload);
    expect(denied[0]).toContain("无权访问编辑器");
    expect(denied[1]).toContain("无权读取运行信息");
    expect(denied[2]).toContain("无权访问编辑器");
    expect(denied[3]).toContain("无权访问组卷功能");
    expect(denied[4]).toContain("无权访问组卷功能");
    expect(denied[5]).toContain("无权访问组卷功能");
    expect(denied[6]).toContain("无权访问组卷功能");
    expect(denied[7]).toContain("无权访问考试资料");
    expect(denied[8]).toContain("无权访问考试资料");
    expect(denied[9]).toContain("无权访问考试资料");
    expect(denied[10]).toContain("无权访问考试资料");
    expect(denied[11]).toContain("无权访问考试资料");
    expect(denied[12]).toContain("无权访问考试资料");
    expect(denied[13]).toContain("无权访问考试资料");
    expect(denied[14]).toContain("无权访问考试资料");
    expect(denied[15]).toContain("无权访问考试资料");
    expect(denied[16]).toContain("无权访问考试资料");
    expect(denied[17]).toContain("无权访问组卷功能");
    expect(denied[18]).toContain("无权访问组卷功能");
    expect(denied[19]).toContain("无权访问组卷功能");
    expect(denied[20]).toContain("无权访问考试资料");
    expect(denied[21]).toContain("无权访问考试资料");
    expect(denied[22]).toContain("无权访问考试资料");
    expect(denied[23]).toContain("无权访问备份与恢复");
    expect(denied[24]).toContain("无权访问备份与恢复");
    expect(denied[25]).toContain("无权访问备份与恢复");
    expect(denied[26]).toContain("无权访问备份与恢复");
    expect(denied[27]).toContain("无权访问 AI 设置");
    expect(denied[28]).toContain("无权访问 AI 设置");
    expect(denied[29]).toContain("无权访问考试资料");
    expect(denied[30]).toContain("无权访问考试资料");
    expect(denied[31]).toContain("无权访问考试资料");
    expect(denied[32]).toContain("无权访问考试资料");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("安全策略阻止内联脚本与远程图片", async () => {
  const dir = tempDir();
  const app = await launch(dir);
  try {
    const window = await app.firstWindow();
    const failures: { url: string; error: string }[] = [];
    window.on("requestfailed", (request) => failures.push({ url: request.url(), error: request.failure()?.errorText ?? "" }));
    const csp = await window.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");

    await window.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.__paperweaveCspPwned = true";
      document.body.append(script);
      const image = new Image();
      image.src = "http://127.0.0.1:9/csp.png";
      document.body.append(image);
    });
    await window.waitForTimeout(400);
    expect(await window.evaluate(() => (window as unknown as { __paperweaveCspPwned?: boolean }).__paperweaveCspPwned)).toBeUndefined();
    const remote = failures.filter((entry) => entry.url.includes("127.0.0.1:9"));
    expect(remote.length).toBeGreaterThan(0);
    expect(remote.every((entry) => entry.error === "csp" || entry.error.includes("ERR_BLOCKED_BY_CSP")), JSON.stringify(remote)).toBe(true);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("粘贴带脚本或远程图片的 HTML 被拒绝，内容不写入且不联网", async () => {
  const dir = tempDir();
  const app = await launch(dir);
  try {
    const window = await app.firstWindow();
    const requests: string[] = [];
    window.on("request", (request) => requests.push(request.url()));
    const editor = window.getByLabel("文本 1").first();
    await editor.evaluate((element) => {
      const data = new DataTransfer();
      data.setData("text/html", '<img src="http://127.0.0.1:9/paste.png" onerror="window.__paperweavePastePwned=1"><script>window.__paperweavePastePwned=2</script>');
      data.setData("text/plain", "纯文本");
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(window.getByRole("alert")).toContainText("不支持直接粘贴带格式的内容或图片");
    await expect(editor).toHaveValue("");
    await window.waitForTimeout(300);
    expect(await window.evaluate(() => (window as unknown as { __paperweavePastePwned?: number }).__paperweavePastePwned)).toBeUndefined();
    expect(requests.filter((url) => url.includes("127.0.0.1:9"))).toEqual([]);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("附件只接受哈希标识，越界路径与未知文件被拒绝", async () => {
  const dir = tempDir();
  const app = await launch(dir);
  try {
    const window = await app.firstWindow();
    const results = await window.evaluate(async () => {
      const bridge = (window as unknown as { paperweave: {
        getImage: (id: string) => Promise<unknown>;
        saveDraft: (value: unknown) => Promise<unknown>;
      } }).paperweave;
      const attempt = (fn: () => Promise<unknown>) => fn().then(() => "resolved", (error: unknown) => String(error));
      return [
        await attempt(() => bridge.getImage("../../ai-key.bin")),
        await attempt(() => bridge.getImage("a".repeat(64))),
        await attempt(() => bridge.saveDraft({ version: 2, blocks: [{ type: "image", id: "../../ai-key.bin", alt: "" }], teacherAnswer: "" })),
      ];
    });
    expect(results[0]).toContain("图片标识无效");
    expect(results[1]).toContain("图片缺失或校验失败");
    expect(results[2]).toContain("内容格式不受支持");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("模型密钥不出现在题目、界面或用户目录文件中", async () => {
  const dir = tempDir();
  const app = await launch(dir);
  const secret = "sk-security-baseline-1234567890";
  try {
    const window = await app.firstWindow();
    await window.getByText("模型服务与密钥设置").click();
    const keyInput = window.getByLabel(/模型密钥/);
    await keyInput.fill(secret);
    await window.getByRole("button", { name: "加密保存密钥" }).click();
    await expect(window.getByText("密钥已加密保存在本机", { exact: false })).toBeVisible();
    await expect(keyInput).toHaveValue("");

    await runAiAndSave(window);
    const storedDraft = await window.evaluate(async () => {
      const bridge = (window as unknown as { paperweave: { loadDraft: () => Promise<unknown> } }).paperweave;
      return JSON.stringify(await bridge.loadDraft());
    });
    expect(storedDraft).toContain("固定响应");
    expect(storedDraft).not.toContain(secret);
    expect(filesContaining(dir, secret)).toEqual([]);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
