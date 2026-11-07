import { Layer } from "effect";
import { Playwright } from "../../src/playwright.ts";
import { readyChromiumDeps } from "./managedDeps.ts";

export const managedPlaywright = Playwright.layer.pipe(Layer.provide(readyChromiumDeps));
