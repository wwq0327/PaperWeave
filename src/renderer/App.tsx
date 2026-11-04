import { useEffect, useState } from "react";
import type { RuntimeVersions } from "../shared/versions";

export default function App() {
  const [versions, setVersions] = useState<RuntimeVersions | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.paperweave
      .getRuntimeVersions()
      .then(setVersions)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  if (error) return <p role="alert">版本信息获取失败：{error}</p>;
  if (!versions) return <p>正在载入…</p>;

  return (
    <main>
      <h1>拾题成卷 PaperWeave</h1>
      <p>应用 {versions.app}</p>
      <ul>
        <li>Electron {versions.electron}</li>
        <li>Node {versions.node}</li>
        <li>Chrome {versions.chrome}</li>
      </ul>
    </main>
  );
}
