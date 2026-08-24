import { Plugin } from "@opencode-ai/core/plugin"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import {
  PluginQueryInvalidRequestError,
  PluginQueryUnavailableError,
  PluginUnavailableError,
} from "@opencode-ai/protocol/errors"

export const PluginHandler = HttpApiBuilder.group(Api, "server.plugin", (handlers) =>
  handlers
    .handle("plugin.list", () =>
      Effect.gen(function* () {
        return yield* response(Plugin.Service.use((plugin) => plugin.list()))
      }),
    )
    .handle("plugin.query.invoke", (request) =>
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        return yield* response(
          plugin
            .query({
              pluginID: request.params.pluginID,
              name: request.params.query,
              version: request.payload.version,
              input: request.payload.input,
            })
            .pipe(
              Effect.catchTags({
                PluginUnavailableError: (error) =>
                  new PluginUnavailableError({
                    kind: "plugin_unavailable",
                    pluginID: error.pluginID,
                    message: `Plugin is unavailable: ${error.pluginID}`,
                  }),
                PluginQueryUnavailableError: (error) =>
                  new PluginQueryUnavailableError({
                    kind: "query_unavailable",
                    pluginID: error.pluginID,
                    query: error.query,
                    version: error.version,
                    message: `Plugin query is unavailable: ${error.pluginID}/${error.query}@${error.version}`,
                  }),
                PluginQueryInvalidRequestError: (error) =>
                  new PluginQueryInvalidRequestError({
                    kind: "invalid_request",
                    pluginID: error.pluginID,
                    query: error.query,
                    version: error.version,
                    message: error.message,
                  }),
              }),
            ),
        )
      }),
    ),
)
