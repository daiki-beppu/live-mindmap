// Story 用: 見る状態の知らせ（sessionLayout の Toast）の出入りの動きの保留 1 件を解く。WaitForPaint は描画の完了、WaitForAnimationSettled はアニメーションの終了を届ける
import * as Animation from "@foldkit/ui/animation";
import { Command as StoryCommand, type StorySimulation } from "foldkit/story";

export const resolveNoticeMotion = <Model, Message>(
  simulation: StorySimulation<Model, Message>,
  pending: StorySimulation<Model, Message>["commands"][number],
): StorySimulation<Model, Message> => {
  const generation = pending.args?.generation as number;
  return pending.name === "WaitForPaint"
    ? StoryCommand.resolve(Animation.WaitForPaint({ generation }), Animation.Message.CompletedWaitForPaint({ generation }))(simulation)
    : StoryCommand.resolve(Animation.WaitForAnimationSettled({ id: pending.args?.id as string, generation }), Animation.Message.EndedAnimation({ generation }))(simulation);
};
