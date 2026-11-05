import type { BasketSelection } from "./basket";
import type { Block } from "./document";
import type { BlankSpace, ItemUpdates, PaperScoring, PaperScoringState, PendingCheck, ScoreConflict } from "./paper";
import type { PaperSnapshot, ResolvedReference, VolumePaper } from "./paper-layout";
import type { AnswerStatus, Classification, QuestionContent, ReviewStatus, SourcePosition, Stage } from "./question";

export interface QuestionSearchView {
  questionId: string;
  versionId: string;
  version: number;
  contentStatus: ReviewStatus;
  answerStatus: AnswerStatus;
  classification: Classification | undefined;
  preview: string;
  source: SourcePosition;
  materialIds: string[];
}

export interface MaterialView {
  materialId: string;
  versionId: string;
  title: string;
  content: Block[];
  source: string;
  status: ReviewStatus;
}

export interface QuestionDetailView {
  questionId: string;
  versionId: string;
  version: number;
  contentStatus: ReviewStatus;
  answerStatus: AnswerStatus;
  content: QuestionContent;
  classification: Classification | undefined;
  materials: MaterialView[];
}

export interface BasketItemView {
  id: string;
  questionId: string;
  questionVersionId: string;
  version: number;
  subQuestionIds: string[];
  primarySubQuestionId: string | null;
  position: number;
  createdAt: string;
  content: QuestionContent;
  dependencies: BasketSelection;
  updates: ItemUpdates;
}

export interface PaperRecordView {
  id: string;
  title: string;
  stage: Stage;
  subject: string;
  grade: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaperItemView {
  id: string;
  paperId: string;
  sectionId: string;
  position: number;
  questionId: string;
  questionVersionId: string;
  subQuestionIds: string[];
  score: number;
  blankSpace: BlankSpace;
  scoring: PaperScoring;
  defaultScore: number;
  scoringState: PaperScoringState;
  scoreConflicts: (ScoreConflict & { confirmed: boolean })[];
  pendingChecks: (PendingCheck & { confirmed: boolean })[];
  updates: ItemUpdates;
  content: QuestionContent;
  createdAt: string;
}

export interface PaperSectionView {
  id: string;
  paperId: string;
  title: string;
  position: number;
  items: PaperItemView[];
}

export interface PaperDetailView {
  paper: PaperRecordView;
  sections: PaperSectionView[];
  totalScore: number;
}

export interface FinalizationCheckView {
  ready: boolean;
  blockers: string[];
  notices: string[];
  references: ResolvedReference[];
}

export interface FinalizationRecordView {
  id: string;
  paperId: string;
  studentPdf: string;
  teacherPdf: string;
  snapshot: PaperSnapshot;
  studentSha256: string;
  teacherSha256: string;
  createdAt: string;
}

export type BeginFinalizationView =
  | { status: "ready"; id: string; student: VolumePaper }
  | { status: "blocked"; check: FinalizationCheckView }
  | { status: "canceled" };
