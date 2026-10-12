import { Runtime } from "foldkit";
import { init, Model, update, view } from "./main.ts";
import { subscriptions } from "./subscription.ts";

const TITLE = "live-mindmap";
const ROOT_ID = "root";

export type MeetingInput = { container: HTMLElement; isMac: boolean };

export const runMeeting = ({ container, isMac }: MeetingInput): void => {
  Runtime.run(
    Runtime.makeApplication({
      Model,
      init: () => ({ model: init(isMac) }),
      update,
      view: (model, h) => ({ title: TITLE, body: h.div([h.Id(ROOT_ID)], [view(model, h)]) }),
      subscriptions,
      container,
    }),
  );
};
