import { Runtime } from "foldkit";
import type { Snapshot } from "../../../../server/src/core/index.ts";
import { init, Model, update, view } from "./main.ts";

const TITLE = "live-mindmap";
const ROOT_ID = "root";

export type CaptureInput = {
  container: HTMLElement;
  snapshot: Snapshot;
};

export const runCapture = ({ container, snapshot }: CaptureInput): void => {
  Runtime.run(
    Runtime.makeApplication({
      Model,
      init: () => ({ model: init(snapshot) }),
      update,
      // Application は container の要素を view の根で置き換えるので、#root（styles.css が高さ 100% にする）を根として描く
      view: (model, h) => ({ title: TITLE, body: h.div([h.Id(ROOT_ID)], [view(model, h)]) }),
      container,
    }),
  );
};
