import { SessionView } from "./SessionView.tsx";
import { useLiveFeed } from "./useLiveFeed.ts";

export function App() {
  const { snapshot, speaking, intake, screenNotice } = useLiveFeed();
  if (!snapshot) return <p className="waiting">サーバーを待っています</p>;
  return <SessionView snapshot={snapshot} speaking={speaking} intake={intake} screenNotice={screenNotice} />;
}
