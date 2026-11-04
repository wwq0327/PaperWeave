/// <reference types="vite/client" />
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
    };
  }
}

export {};
