import { MapView } from "./MapView.tsx";
import { useSnapshot } from "./useSnapshot.ts";

export function App() {
  const snapshot = useSnapshot();
  if (!snapshot) return <p className="waiting">サーバーを待っています</p>;
  return (
    <div className="map">
      <MapView snapshot={snapshot} />
    </div>
  );
}
