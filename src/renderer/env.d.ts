/// <reference types="vite/client" />
import type { AiDraft, AiInput } from "../shared/ai";
import type { AiConfig } from "../shared/ai-config";
import type { BasketSelection } from "../shared/basket";
import type { Block, Draft } from "../shared/document";
import type {
  ExamAttachment,
  ExamDetailView,
  ExamFileRole,
  ExamImportResult,
  ExamInput,
  ExamQuestionSummary,
  ExamRecord,
  ExamSectionRecord,
  OriginalFileView,
} from "../shared/exam";
import type { SaveIntakeResult } from "../shared/intake";
import type {
  BeginFinalizationView,
  BasketItemView,
  FinalizationCheckView,
  FinalizationRecordView,
  PaperDetailView,
  PaperItemView,
  PaperRecordView,
  QuestionDetailView,
  QuestionSearchView,
} from "../shared/paper-api";
import type { BlankSpace, PaperScoring } from "../shared/paper";
import type { VolumePaper } from "../shared/paper-layout";
import type { Classification, QuestionContent, ReviewStatus } from "../shared/question";
import type { RuntimeVersions } from "../shared/versions";

declare global {
  interface Window {
    paperweave: {
      getRuntimeVersions(): Promise<RuntimeVersions>;
      platform: string;
      loadDraft(): Promise<Draft>;
      saveDraft(draft: Draft): Promise<void>;
      chooseImage(): Promise<{ id: string; url: string } | null>;
      getImage(id: string): Promise<string>;
      exportPdf(): Promise<{ canceled: true } | { canceled: false; path: string; openError: string }>;
      beginPdfPair(): Promise<string | null>;
      captureStudentPdf(id: string): Promise<void>;
      finishPdfPair(id: string): Promise<{ directory: string; studentPath: string; teacherPath: string; openErrors: string[] }>;
      cancelPdfPair(id: string): Promise<void>;
      getAiConfig(): Promise<AiConfig & { hasKey: boolean }>;
      saveAiConfig(config: AiConfig): Promise<AiConfig & { hasKey: boolean }>;
      saveAiKey(key: string): Promise<AiConfig & { hasKey: boolean }>;
      clearAiKey(): Promise<AiConfig & { hasKey: boolean }>;
      generateAiDraft(requestId: string, input: AiInput): Promise<AiDraft>;
      cancelAiDraft(requestId: string): Promise<boolean>;
      extractPdfText(): Promise<{ name: string; pages: { page: number; text: string }[]; hasText: boolean } | null>;
      loadPdfForImages(): Promise<{ name: string; data: Uint8Array; pages: { page: number; text: string }[]; hasText: boolean } | null>;
      searchQuestions(filter: unknown): Promise<QuestionSearchView[]>;
      getQuestionDetail(versionId: string): Promise<QuestionDetailView>;
      listBasket(): Promise<BasketItemView[]>;
      addToBasket(questionId: string, versionId: string, subQuestionId: string | null, confirm?: boolean): Promise<{ status: "confirmation_required"; selection: BasketSelection } | { status: "added"; item: BasketItemView }>;
      removeBasketItem(id: string): Promise<void>;
      clearBasket(): Promise<void>;
      listPapers(): Promise<PaperRecordView[]>;
      createPaper(input: { title: string; stage: "小学" | "初中" | "高中"; subject: string; grade: string }): Promise<PaperRecordView>;
      getPaper(paperId: string): Promise<PaperDetailView>;
      addPaperSection(paperId: string, title: string): Promise<{ id: string; paperId: string; title: string; position: number }>;
      removePaperSection(sectionId: string): Promise<void>;
      addBasketItemToPaper(paperId: string, sectionId: string, basketItemId: string): Promise<PaperItemView>;
      removePaperItem(itemId: string): Promise<void>;
      movePaperItem(itemId: string, sectionId: string, position: number): Promise<void>;
      setPaperItemScore(itemId: string, score: number): Promise<PaperItemView>;
      setPaperItemBlankSpace(itemId: string, blankSpace: BlankSpace): Promise<PaperItemView>;
      setPaperItemScoring(itemId: string, scoring: PaperScoring): Promise<PaperItemView>;
      confirmPaperScoreConflict(itemId: string, key: string): Promise<PaperItemView>;
      listPaperFinalizations(paperId: string): Promise<FinalizationRecordView[]>;
      checkPaperFinalize(paperId: string): Promise<FinalizationCheckView>;
      beginPaperFinalize(paperId: string): Promise<BeginFinalizationView>;
      capturePaperStudent(id: string): Promise<void>;
      getPaperTeacherVolume(id: string): Promise<VolumePaper>;
      finishPaperFinalize(id: string): Promise<{ record: FinalizationRecordView; openErrors: string[] }>;
      cancelPaperFinalize(id: string): Promise<void>;
      reprintPaper(id: string): Promise<{ studentPath: string; teacherPath: string; openErrors: string[] }>;
      listExams(): Promise<ExamRecord[]>;
      getExam(examId: string): Promise<ExamDetailView>;
      importExam(input: ExamInput): Promise<{ status: "canceled" } | ({ status: "imported" } & ExamImportResult)>;
      attachExamFile(examId: string, role: ExamFileRole): Promise<{ status: "canceled" } | ({ status: "attached" } & ExamAttachment)>;
      addExamSection(examId: string, title: string, subject?: string): Promise<ExamSectionRecord>;
      getExamFile(fileId: string): Promise<{ file: OriginalFileView; data: Uint8Array }>;
      listExamQuestions(examId: string): Promise<ExamQuestionSummary[]>;
      saveIntake(input: { examId: string; sectionId: string; questionId?: string; content: QuestionContent; classification: Classification; submit?: boolean }): Promise<SaveIntakeResult>;
      saveIntakeFigure(dataUrl: string): Promise<{ id: string; url: string }>;
      createMaterial(input: { title: string; content: Block[]; source: string }): Promise<{ id: string; materialId: string; version: number; title: string; content: Block[]; source: string; status: ReviewStatus; createdAt: string }>;
      setMaterialStatus(versionId: string, status: ReviewStatus): Promise<void>;
    };
  }
}

export {};
