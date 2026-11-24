/**
 * Annotate it — annotate chats and documents for OpenCode Desktop.
 *
 * Port of dsh-annotate-it (MIT): select a passage, pick a quick reply or write
 * a comment (typing or dictation), and the quote joins the composer's native
 * queue; Enter sends the whole review as one message. Works in the timeline
 * and in right-panel file previews. Two modes per session: standby (the app's
 * own quoting, untouched) and review (quick bar, highlights, hover cards).
 */

import { createEffect, onCleanup } from "solid-js"
import { Command, ComposerPill, createKeyed, Plugin, SettingsPage, Slot, Style } from "@opencode/plugin/gui"
import { definition } from "./gui/definition"
import { createManager } from "./gui/manager"
import { AnnotateOverlay, AnnotateSettings, setManager } from "./gui/ui"
import css from "./gui/styles.css?inline"

export default Plugin.define({
  ...definition,
  setup(ctx) {
    const manager = createManager(ctx)
    setManager(manager)
    const stop = manager.start()

    ctx.add(Style, css)

    // The floating UI follows the app's color scheme.
    createEffect(() => {
      document.documentElement.classList.toggle("ait-dark", ctx.appearance.mode() === "dark")
    })

    // Review mode hides the app's own quote toolbar; re-sync on session switches
    // and when the per-session mode store finishes loading.
    createEffect(() => {
      manager.reviewing()
      manager.syncReviewClass()
    })

    // Repaint when the routed session or its stored notes change.
    createEffect(() => {
      const session = ctx.sessions.current()
      if (session) {
        ctx.stores.notes(session)?.value
        ctx.stores.mode(session)?.value
      }
      manager.schedulePaint()
    })

    ctx.add(
      Command,
      (): Command => ({
        id: "toggle",
        title: ctx.t("command.toggle"),
        keywords: "annotate review quote аннотация рецензия",
        bind: "mod+shift+a",
        slash: { name: "annotate" },
        enabled: !!ctx.sessions.current(),
        run: () => {
          if (!ctx.sessions.current()) {
            ctx.toast.show({ title: ctx.t("toast.noSession") })
            return
          }
          manager.setReviewing(!manager.reviewing())
        },
      }),
    )

    ctx.add(
      Command,
      (): Command => ({
        id: "clear",
        title: ctx.t("command.clear"),
        enabled: !!ctx.sessions.current() && manager.reviewing() && manager.pendingCount() > 0,
        run: () => void manager.clearAll(),
      }),
    )

    ctx.add(SettingsPage, {
      id: "annotate-it",
      icon: "outline-browser-annotate",
      get title() {
        return ctx.t("title")
      },
      get entries() {
        return [
          { id: "pencil", title: ctx.t("settings.pencil"), keywords: "pencil selection кнопка выделение" },
          { id: "highlights", title: ctx.t("settings.highlights"), keywords: "highlight подсветка" },
          { id: "actions", title: ctx.t("settings.actions"), keywords: "quick replies быстрые ответы" },
          { id: "keys", title: ctx.t("settings.keys"), keywords: "keybind shortcuts клавиши" },
        ]
      },
      render: () => <AnnotateSettings />,
    })

    // Clear-all appears while a review has pending notes.
    ctx.add(ComposerPill, {
      id: "clear",
      show: (input) => {
        const reviewing = ctx.stores.mode(input.session)?.value?.reviewing ?? false
        const list = ctx.stores.notes(input.session)?.value?.list ?? []
        const count = list.filter((note) => note.comments.some((comment) => !comment.sent)).length
        if (!reviewing || count === 0) return undefined
        return {
          label: `${ctx.t("pill.clear")} · ${count}`,
          icon: "close",
          title: ctx.t("pill.clearTitle"),
          run: () => void manager.clearAll(),
        }
      },
    })

    ctx.add(Slot, {
      at: "window.bottom",
      render: () => <AnnotateOverlay />,
    })

    // A sent user message carrying a note's quote marks that note sent. The
    // prompt is committed by the time a turn starts or a queued message lands;
    // the delayed rescans catch the message list finishing its sync.
    createKeyed(
      () => ctx.servers.get("sidecar")?.data,
      (data) => {
        const scan = (sessionID: string) => {
          const messages = data.session.message.list(sessionID)
          const recent = messages.filter((info) => info.type === "user").slice(-10)
          for (const info of recent) {
            if (info.type === "user") manager.trackSent(sessionID, info.text)
          }
        }
        const timers: ReturnType<typeof setTimeout>[] = []
        const react = (sessionID: string) => {
          scan(sessionID)
          timers.push(setTimeout(() => scan(sessionID), 400))
          timers.push(setTimeout(() => scan(sessionID), 1500))
        }
        const offStarted = data.on("session.execution.started", (event) => react(event.data.sessionID))
        const offDelivered = data.on("session.inbox.delivered", (event) => react(event.data.sessionID))
        onCleanup(() => {
          offStarted()
          offDelivered()
          for (const timer of timers) clearTimeout(timer)
        })
      },
    )

    return stop
  },
})