import { Runtime } from "foldkit";
import { Flags, readFlags } from "../startFlags.ts";
import { init, Model, update, view } from "./main.ts";
import { subscriptions } from "./subscription.ts";

const TITLE = "live-mindmap";
const ROOT_ID = "root";

export type MeetingInput = { container: HTMLElement; isMac: boolean };

export const runMeeting = ({ container, isMac }: MeetingInput): void => {
  Runtime.run(
    Runtime.makeApplication({
      Model,
      Flags,
      init: (startFlags) => ({ model: init(isMac, startFlags) }),
      update,
      view: (model, h) => ({ title: TITLE, body: h.div([h.Id(ROOT_ID), h.Class("meeting")], [view(model, h)]) }),
      subscriptions,
      container,
    }),
    { flags: readFlags },
  );
};
