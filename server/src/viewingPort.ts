import { Context, Effect, Layer, Ref, type Scope } from "effect";
import { HttpRouter, HttpServer, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import { BASE_STATUS, FEED_PING_INTERVAL_MS, ForbiddenOrigin, UnsupportedRoute, feed, layerNodeServer, portOf, respondWith } from "./httpServing.ts";
import { ReviewBuild, type ReviewPageFailed } from "./review.ts";
import type { Viewers } from "./viewers.ts";

type ViewingPort = { readonly port: number; readonly allow: (hostname: string) => Effect.Effect<void> };

const respond = respondWith(BASE_STATUS);

export const openViewingPort = (pingIntervalMs: number = FEED_PING_INTERVAL_MS): Effect.Effect<ViewingPort, HttpServerError.ServeError | ReviewPageFailed, Viewers | ReviewBuild | Scope.Scope> =>
  Effect.gen(function* () {
    const { build } = yield* ReviewBuild;
    const page = yield* build;
    const allowed = yield* Ref.make<string | undefined>(undefined);
    const OriginCheck = HttpRouter.middleware((httpEffect) =>
      Effect.gen(function* () {
        const { origin } = (yield* HttpServerRequest.HttpServerRequest).headers;
        if (origin !== undefined && origin !== (yield* Ref.get(allowed))) return yield* new ForbiddenOrigin();
        return yield* httpEffect;
      }), { global: true });
    const routes = HttpRouter.addAll([
      HttpRouter.route("GET", "/ws", Effect.gen(function* () {
        const { origin } = (yield* HttpServerRequest.HttpServerRequest).headers;
        if (origin === undefined || origin !== (yield* Ref.get(allowed))) return yield* new ForbiddenOrigin();
        return yield* feed;
      })),
      HttpRouter.route("GET", "/", Effect.succeed(HttpServerResponse.text(page, { contentType: "text/html; charset=utf-8" }))),
    ]);
    const context = yield* Layer.build(layerNodeServer(0, pingIntervalMs));
    const handler = yield* HttpRouter.toHttpEffect(Layer.mergeAll(routes, UnsupportedRoute, OriginCheck));
    yield* HttpServer.serveEffect(respond(handler)).pipe(Effect.provide(context));
    const port = yield* portOf(Context.get(context, HttpServer.HttpServer).address);
    return { port, allow: (hostname: string) => Ref.set(allowed, `https://${hostname}`) };
  });
