import { Location } from "@opencode-ai/schema/location"
import { Plugin } from "@opencode-ai/schema/plugin"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location.js"
import {
  PluginQueryInvalidRequestError,
  PluginQueryUnavailableError,
  PluginUnavailableError,
} from "../errors.js"

export const PluginGroup = HttpApiGroup.make("server.plugin")
  .add(
    HttpApiEndpoint.get("plugin.list", "/api/plugin", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Plugin.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.plugin.list",
          summary: "List plugins",
          description: "Retrieve currently loaded plugins.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("plugin.query.invoke", "/api/plugin/:pluginID/query/:query", {
      params: { pluginID: Plugin.ID, query: Schema.String },
      query: LocationQuery,
      payload: Plugin.QueryRequest,
      success: Location.response(Plugin.QueryResponse),
      error: [PluginUnavailableError, PluginQueryUnavailableError, PluginQueryInvalidRequestError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.plugin.query.invoke",
          summary: "Invoke a plugin query",
          description: "Invoke a versioned read-only query registered by an active plugin.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "plugin",
      description: "Experimental plugin routes.",
    }),
  )
