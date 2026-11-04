/// <reference types="vite/client" />
import type { AiDraft, AiInput } from "../shared/ai";
import type { AiConfig } from "../shared/ai-config";
import type { Draft } from "../shared/document";
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
    };
  }
}

export {};
