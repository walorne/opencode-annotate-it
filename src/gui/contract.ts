import { Schema } from "effect"
import { Ipc } from "@opencode/plugin/gui"

/** Selection sampled from the desktop browser panes by the main process. */
export const BrowserSelection = Ipc.define({
  id: "opencode-annotate-it.browserSelection",
  methods: {},
  events: {
    selection: Schema.Struct({
      text: Schema.String,
      url: Schema.String,
      title: Schema.String,
      pressing: Schema.Boolean,
      rect: Schema.Struct({
        top: Schema.Number,
        left: Schema.Number,
        right: Schema.Number,
        bottom: Schema.Number,
      }),
    }),
    clear: Schema.Struct({}),
  },
})