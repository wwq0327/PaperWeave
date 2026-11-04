export interface RuntimeVersions {
  app: string;
  electron: string | null;
  node: string | null;
  chrome: string | null;
}

export interface RuntimeVersionSource {
  app: string;
  electron?: string;
  node?: string;
  chrome?: string;
}

export function getRuntimeVersions(src: RuntimeVersionSource): RuntimeVersions {
  return {
    app: src.app,
    electron: src.electron ?? null,
    node: src.node ?? null,
    chrome: src.chrome ?? null,
  };
}
