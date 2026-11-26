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
import { BrowserSelection } from "./gui/contract"
import { definition } from "./gui/definition"
import { normalizeQuote } from "./gui/dom"
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

    // The accent is user-configurable; everything else follows the app theme
    // through its CSS tokens.
    createEffect(() => {
      document.documentElement.style.setProperty("--ait-accent", manager.accent())
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

    // Browser panes live in separate web contents; the main process samples
    // their selection and pushes it here.
    const browserSelection = ctx.main(BrowserSelection)
    browserSelection.on("selection", (data) => {
      // While the button is held inside the page the selection is still being
      // drawn; showing the panel (and focusing its field) would break the drag.
      if (data.pressing) return
      const text = normalizeQuote(data.text)
      if (!text) return
      manager.setExternalTarget({
        text,
        rect: data.rect,
        line: data.rect,
        range: null,
        source: { kind: "browser", url: data.url, title: data.title },
      })
    })
    browserSelection.on("clear", () => manager.clearExternalTarget())

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
  main(ctx) {
    const provider = ctx.provide(BrowserSelection, {})
    const last = new Map<number, string>()

    const sample = `(() => {
      if (!window.__annotateItWatch) {
        window.__annotateItWatch = true;
        window.__annotateItPressing = false;
        const down = (e) => { if (e.button === 0) window.__annotateItPressing = true; };
        const up = () => { window.__annotateItPressing = false; };
        window.addEventListener('pointerdown', down, true);
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', up, true);
        window.addEventListener('blur', up);
        document.addEventListener('dragend', up, true);
      }
      const s = window.getSelection();
      if (!s || s.isCollapsed || s.rangeCount === 0) return null;
      const text = s.toString().trim();
      if (!text) return null;
      const r = s.getRangeAt(0).getBoundingClientRect();
      return {
        text: text.slice(0, 20000),
        url: location.href,
        title: document.title || "",
        pressing: !!window.__annotateItPressing,
        rect: { top: r.top, left: r.left, right: r.right, bottom: r.bottom }
      };
    })()`

    type Sample = {
      text: string
      url: string
      title: string
      pressing: boolean
      rect: { top: number; left: number; right: number; bottom: number }
    }

    const timer = setInterval(async () => {
      for (const win of ctx.windows.list()) {
        const children = (win.contentView as unknown as { children?: unknown[] }).children ?? []
        for (const child of children) {
          const view = child as {
            webContents?: {
              id: number
              isDestroyed(): boolean
              getURL(): string
              getZoomFactor(): number
              executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
            }
            getBounds?: () => { x: number; y: number; width: number; height: number }
          }
          const wc = view.webContents
          if (!wc || wc.isDestroyed() || !view.getBounds) continue
          const url = wc.getURL()
          if (!/^(https?|file):/.test(url)) continue
          let result: Sample | null = null
          try {
            result = (await wc.executeJavaScript(sample, true)) as Sample | null
          } catch {
            continue
          }
          const key = result ? `${result.text}\u0000${result.url}\u0000${result.pressing}` : ""
          if (last.get(wc.id) === key) continue
          last.set(wc.id, key)
          if (!result) {
            provider.emit("clear", {})
            continue
          }
          const bounds = view.getBounds()
          const zoom = wc.getZoomFactor() || 1
          provider.emit("selection", {
            text: result.text,
            url: result.url,
            title: result.title,
            pressing: result.pressing,
            rect: {
              top: bounds.y + result.rect.top * zoom,
              left: bounds.x + result.rect.left * zoom,
              right: bounds.x + result.rect.right * zoom,
              bottom: bounds.y + result.rect.bottom * zoom,
            },
          })
        }
      }
    }, 400)

    ctx.onCleanup(() => clearInterval(timer))
  },
})