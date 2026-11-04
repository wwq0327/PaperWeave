import type { Block, Draft } from "./document";

export type Volume = "student" | "teacher";

/** 每个卷只拿自己允许的内容字段；学生卷永远拿不到答案。 */
export interface VolumeSections {
  blocks: Block[];
  answer: string | null;
}

export function volumeSections(draft: Draft, volume: Volume): VolumeSections {
  const answer = draft.teacherAnswer.trim();
  return {
    blocks: draft.blocks,
    answer: volume === "teacher" && answer ? draft.teacherAnswer : null,
  };
}
