/**
 * Floating UI, DSH-style: dark compact panels, glyph icons, one-line comment
 * field with autofocus and a round arrow-up send button.
 * - standby: a small round pencil button diagonally above-left of the selection;
 * - review: chips row + field row (input, mic, clear, send);
 * - chip menu, action editor, annotation hover card in the same dark look.
 * Everything portals to the body and is marked `data-annotate-it`.
 */

import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { usePlugin } from "@opencode/plugin/gui"
import type { definition, Note } from "./definition"
import type { Manager } from "./manager"

let managerRef: Manager | undefined
export function setManager(manager: Manager) {
  managerRef = manager
}
const manager = () => managerRef!

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))

function chipFontSize(label: string) {
  const length = label.length
  if (length <= 4) return "12.5px"
  if (length <= 7) return "12px"
  if (length <= 10) return "11px"
  if (length <= 14) return "10.25px"
  return "9.5px"
}

// ---------------------------------------------------------------- glyphs (DSH)

const svgProps = { width: 14, height: 14, viewBox: "0 0 16 16", "aria-hidden": "true" as const }

function ArrowUpGlyph() {
  return (
    <svg {...svgProps} style={{ display: "block" }}>
      <path fill="currentColor" d="M8.6 3.1v8.4H7.4V3.1L4.2 6.3 3.4 5.5 8 0.9l4.6 4.6-.8.8-3.2-3.2Z" />
    </svg>
  )
}

function QuoteGlyph() {
  return (
    <svg {...svgProps} style={{ display: "block" }}>
      <path
        fill="currentColor"
        d="M4.6 3.2C3 4 2.2 5.4 2.2 7c0 1.1.8 1.9 1.8 1.9.9 0 1.6-.6 1.6-1.5 0-.8-.6-1.4-1.4-1.4h-.2c.2-.7.8-1.3 1.6-1.8l-1-1Zm6.2 0C9.2 4 8.4 5.4 8.4 7c0 1.1.8 1.9 1.8 1.9.9 0 1.6-.6 1.6-1.5 0-.8-.6-1.4-1.4-1.4h-.2c.2-.7.8-1.3 1.6-1.8l-1-1Z"
      />
    </svg>
  )
}

function ReviewGlyph() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ display: "block" }}
      fill="none"
      stroke="currentColor"
      stroke-width={1.5}
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M11.6 2.4a1.8 1.8 0 0 1 2.5 2.5l-8.3 8.3-3.5.9.9-3.5 8.4-8.2Z" />
      <path d="m10.2 3.8 2 2" />
    </svg>
  )
}

function CrossGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden="true" style={{ display: "block" }}>
      <path
        fill="currentColor"
        d="M8 6.9 4.9 3.8 3.8 4.9 6.9 8l-3.1 3.1 1.1 1.1L8 9.1l3.1 3.1 1.1-1.1L9.1 8l3.1-3.1-1.1-1.1L8 6.9Z"
      />
    </svg>
  )
}

function MicGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden="true" style={{ display: "block" }}>
      <path
        fill="currentColor"
        d="M8 1a2.6 2.6 0 0 1 2.6 2.6v3.2A2.6 2.6 0 0 1 8 9.4 2.6 2.6 0 0 1 5.4 6.8V3.6A2.6 2.6 0 0 1 8 1Zm-1 2.6v3.2a1 1 0 0 0 2 0V3.6a1 1 0 0 0-2 0ZM3.5 7a.75.75 0 0 1 .75.75A3.75 3.75 0 0 0 8 11.5a3.75 3.75 0 0 0 3.75-3.75A.75.75 0 0 1 13.25 7 5.25 5.25 0 0 1 8.75 12.2V14h1.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5h1.5v-1.8A5.25 5.25 0 0 1 2.75 7 .75.75 0 0 1 3.5 7Z"
      />
    </svg>
  )
}

function ExitGlyph() {
  return (
    <svg {...svgProps} style={{ display: "block" }}>
      <path
        fill="currentColor"
        d="M8 1a.85.85 0 0 1 .85.85v5.3a.85.85 0 0 1-1.7 0V1.85A.85.85 0 0 1 8 1Zm3.4 3.1a.85.85 0 0 1 1.05.4 6 6 0 1 1-8.9 0 .85.85 0 1 1 1.05.4 4.3 4.3 0 1 0 6.8 0 .85.85 0 0 1 0-.8Z"
      />
    </svg>
  )
}

// ---------------------------------------------------------------- placement

type Anchor = { top: number; bottom: number; left: number; right: number }

/**
 * Place a floating box above (or below) an anchor line, centered and clamped.
 * The element renders hidden first so its size can be measured; an unmeasured
 * box uses an estimate, never blocks rendering.
 */
function usePlacement(anchor: () => Anchor | undefined, estimate: { width: number; height: number }) {
  const [size, setSize] = createSignal({ width: 0, height: 0 })
  const ref = (el: HTMLElement) => {
    const observer = new ResizeObserver(() => setSize({ width: el.offsetWidth, height: el.offsetHeight }))
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  }
  const place = () => {
    const box = anchor()
    if (!box) return undefined
    const measured = size()
    const width = measured.width || estimate.width
    const height = measured.height || estimate.height
    const margin = 8
    const center = box.left + (box.right - box.left) / 2
    const left = clamp(center - width / 2, margin, window.innerWidth - width - margin)
    const above = box.top - height - margin >= margin
    const top = above
      ? box.top - height - margin
      : Math.min(box.bottom + margin, window.innerHeight - height - margin)
    return { top, left, ready: measured.width > 0 }
  }
  return { ref, place }
}

// ---------------------------------------------------------------- mic button

function MicButton(props: { value: () => string; onText: (text: string) => void }) {
  const ctx = usePlugin<typeof definition>()
  const [listening, setListening] = createSignal(false)
  let recognition: { stop: () => void } | undefined
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  const canDictate = typeof SpeechRecognition === "function"

  onCleanup(() => {
    try {
      recognition?.stop()
    } catch {
      /* ignore */
    }
  })

  const toggle = () => {
    if (!canDictate) return
    if (listening()) {
      try {
        recognition?.stop()
      } catch {
        /* ignore */
      }
      return
    }
    const instance = new SpeechRecognition()
    instance.lang = document.documentElement.lang || "ru-RU"
    instance.interimResults = true
    instance.continuous = false
    instance.onresult = (event: any) => {
      let finalText = ""
      let interimText = ""
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        const transcript = result[0]?.transcript ?? ""
        if (result.isFinal) finalText += transcript
        else interimText += transcript
      }
      const base = props.value().trim()
      const spoken = (finalText || interimText).trim()
      if (!spoken) return
      props.onText(base ? `${base} ${spoken}` : spoken)
    }
    instance.onend = () => setListening(false)
    instance.onerror = () => setListening(false)
    recognition = instance
    try {
      instance.start()
      setListening(true)
    } catch {
      setListening(false)
    }
  }

  return (
    <button
      type="button"
      class={`ait-tool ait-mic${listening() ? " ait-mic-live" : ""}`}
      title={canDictate ? ctx.t("dictate") : ctx.t("dictateUnavailable")}
      aria-label={ctx.t("dictate")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={toggle}
    >
      <MicGlyph />
    </button>
  )
}

// ---------------------------------------------------------------- standby pencil

function StandbyPencil() {
  const ctx = usePlugin<typeof definition>()
  const m = manager()
  const position = () => {
    const target = m.target()
    if (!target || m.reviewing() || !m.pencilEnabled()) return undefined
    const size = 24
    return {
      top: clamp(target.line.top - size - 8, 8, window.innerHeight - size - 8),
      left: clamp(target.line.left - size - 8, 8, window.innerWidth - size - 8),
    }
  }
  return (
    <Show when={position()}>
      {(place) => (
        <button
          type="button"
          data-annotate-it="pencil"
          class="ait-pencil"
          title={ctx.t("pill.enter")}
          aria-label={ctx.t("pill.enter")}
          style={{ top: `${place().top}px`, left: `${place().left}px` }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => m.setReviewing(true)}
        >
          <ReviewGlyph />
        </button>
      )}
    </Show>
  )
}

// ---------------------------------------------------------------- review panel

function ReviewPanel() {
  const ctx = usePlugin<typeof definition>()
  const m = manager()
  let input: HTMLInputElement | undefined
  const anchor = () => {
    const target = m.target()
    return m.reviewing() && target ? target.line : undefined
  }
  const { ref, place } = usePlacement(anchor, { width: 320, height: 64 })

  // Focus the field as soon as a passage is picked, so dictation can start at
  // once. The app's own focus management can steal the first attempt, so retry
  // until the field really holds focus.
  createEffect(() => {
    if (m.target() && m.reviewing()) {
      let tries = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      const attempt = () => {
        timer = undefined
        if (!input || !m.target() || !m.reviewing()) return
        input.focus({ preventScroll: true })
        const end = input.value.length
        try {
          input.setSelectionRange(end, end)
        } catch {
          /* ignore */
        }
        if (document.activeElement !== input && tries++ < 8) {
          timer = setTimeout(attempt, 40)
        }
      }
      queueMicrotask(attempt)
      onCleanup(() => {
        if (timer) clearTimeout(timer)
      })
    }
  })

  const commit = () => {
    if (m.addCustom(m.customDraft())) m.setCustomDraft("")
  }

  return (
    <Show when={anchor() && place()}>
      {(position) => (
        <div
          ref={ref}
          data-annotate-it="review-panel"
          class="ait-mini"
          role="toolbar"
          aria-label={ctx.t("title")}
          style={{
            top: `${position().top}px`,
            left: `${position().left}px`,
            visibility: position().ready ? undefined : "hidden",
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div class="ait-mini-row">
            <For each={m.actions()}>
              {(action) => (
                <button
                  type="button"
                  class="ait-qchip"
                  style={{ "font-size": chipFontSize(action.label) }}
                  title={action.text}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => m.quickReply(action)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    m.setChipMenu({ actionId: action.id, x: event.clientX, y: event.clientY, confirming: false })
                  }}
                >
                  <span class="ait-qchip-label">{action.label}</span>
                </button>
              )}
            </For>
            <button
              type="button"
              class="ait-qchip ait-qchip-add"
              title={ctx.t("bar.addAction")}
              aria-label={ctx.t("bar.addAction")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => m.setEditor({ id: null, label: "", text: "", x: event.clientX, y: event.clientY })}
            >
              +
            </button>
            <button
              type="button"
              class="ait-qchip ait-qchip-icon"
              title={ctx.t("bar.quote")}
              aria-label={ctx.t("bar.quote")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => m.plainQuote()}
            >
              <QuoteGlyph />
            </button>
            <button
              type="button"
              class="ait-qchip ait-qchip-icon ait-exit"
              title={ctx.t("pill.exit")}
              aria-label={ctx.t("pill.exit")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => m.setReviewing(false)}
            >
              <ExitGlyph />
            </button>
          </div>
          <div class="ait-mini-row ait-mini-field">
            <input
              ref={input}
              class="ait-mini-input"
              value={m.customDraft()}
              placeholder={ctx.t("card.placeholder")}
              spellcheck={false}
              onInput={(event) => m.setCustomDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                  event.preventDefault()
                  commit()
                } else if (event.key === "Escape") {
                  event.preventDefault()
                  m.cancelTarget()
                }
              }}
            />
            <MicButton value={() => m.customDraft()} onText={(text) => m.setCustomDraft(text)} />
            <Show when={m.customDraft().trim() !== ""}>
              <button
                type="button"
                class="ait-tool"
                title={ctx.t("field.clear")}
                aria-label={ctx.t("field.clear")}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => m.setCustomDraft("")}
              >
                <CrossGlyph />
              </button>
            </Show>
            <button
              type="button"
              class="ait-sendicon"
              disabled={m.customDraft().trim() === ""}
              title={ctx.t("card.add")}
              aria-label={ctx.t("card.add")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={commit}
            >
              <ArrowUpGlyph />
            </button>
          </div>
        </div>
      )}
    </Show>
  )
}

// ---------------------------------------------------------------- chip menu

function ChipMenu() {
  const ctx = usePlugin<typeof definition>()
  const m = manager()
  const [confirming, setConfirming] = createSignal(false)

  createEffect(() => {
    const menu = m.chipMenu()
    setConfirming(false)
    if (menu) {
      const outside = (event: PointerEvent) => {
        const element = event.target instanceof Element ? event.target : null
        if (element?.closest('[data-annotate-it="chip-menu"]')) return
        m.setChipMenu(null)
      }
      const timer = setTimeout(() => document.addEventListener("pointerdown", outside, true), 0)
      onCleanup(() => {
        clearTimeout(timer)
        document.removeEventListener("pointerdown", outside, true)
      })
    }
  })

  const position = () => {
    const menu = m.chipMenu()
    if (!menu) return undefined
    return {
      top: clamp(menu.y + 6, 8, window.innerHeight - 120),
      left: clamp(menu.x - 60, 8, window.innerWidth - 180),
    }
  }

  return (
    <Show when={m.chipMenu() && position()}>
      {(place) => (
        <div
          data-annotate-it="chip-menu"
          class="ait-menu"
          style={{ top: `${place().top}px`, left: `${place().left}px` }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <Show
            when={!confirming()}
            fallback={
              <>
                <div class="ait-menu-label">{ctx.t("menu.deleteConfirm")}</div>
                <button
                  type="button"
                  class="ait-menu-item ait-danger"
                  onClick={() => {
                    const menu = m.chipMenu()
                    if (menu) m.removeAction(menu.actionId)
                  }}
                >
                  {ctx.t("menu.deleteSure")}
                </button>
                <button type="button" class="ait-menu-item" onClick={() => setConfirming(false)}>
                  {ctx.t("card.cancel")}
                </button>
              </>
            }
          >
            <button
              type="button"
              class="ait-menu-item"
              onClick={() => {
                const menu = m.chipMenu()
                if (!menu) return
                const action = m.actions().find((entry) => entry.id === menu.actionId)
                m.setEditor({
                  id: menu.actionId,
                  label: action?.label ?? "",
                  text: action?.text ?? "",
                  x: menu.x,
                  y: menu.y,
                })
                m.setChipMenu(null)
              }}
            >
              {ctx.t("menu.edit")}
            </button>
            <button type="button" class="ait-menu-item ait-danger" onClick={() => setConfirming(true)}>
              {ctx.t("menu.delete")}
            </button>
          </Show>
        </div>
      )}
    </Show>
  )
}

// ---------------------------------------------------------------- action editor

function ActionEditor() {
  const ctx = usePlugin<typeof definition>()
  const m = manager()
  const [label, setLabel] = createSignal("")
  const [text, setText] = createSignal("")

  createEffect(() => {
    const editor = m.editor()
    if (editor) {
      setLabel(editor.label)
      setText(editor.text)
      const outside = (event: PointerEvent) => {
        const element = event.target instanceof Element ? event.target : null
        if (element?.closest('[data-annotate-it="action-editor"]')) return
        m.setEditor(null)
      }
      const timer = setTimeout(() => document.addEventListener("pointerdown", outside, true), 0)
      onCleanup(() => {
        clearTimeout(timer)
        document.removeEventListener("pointerdown", outside, true)
      })
    }
  })

  const position = () => {
    const editor = m.editor()
    if (!editor) return undefined
    return {
      top: clamp(editor.y - 100, 8, window.innerHeight - 240),
      left: clamp(editor.x - 140, 8, window.innerWidth - 320),
    }
  }

  const save = () => {
    const editor = m.editor()
    if (!editor) return
    m.saveAction(editor.id, label(), text())
  }

  return (
    <Show when={m.editor() && position()}>
      {(place) => (
        <div
          data-annotate-it="action-editor"
          class="ait-card ait-editor"
          style={{ top: `${place().top}px`, left: `${place().left}px` }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div class="ait-card-title">{ctx.t("editor.title")}</div>
          <label class="ait-field">
            <span>{ctx.t("editor.label")}</span>
            <input
              class="ait-input"
              value={label()}
              onInput={(event) => setLabel(event.currentTarget.value)}
              onKeyDown={(event) => event.key === "Enter" && save()}
            />
          </label>
          <label class="ait-field">
            <span>{ctx.t("editor.phrase")}</span>
            <input
              class="ait-input"
              value={text()}
              onInput={(event) => setText(event.currentTarget.value)}
              onKeyDown={(event) => event.key === "Enter" && save()}
            />
          </label>
          <div class="ait-card-footer">
            <button type="button" class="ait-btn ait-btn-ghost" onClick={() => m.setEditor(null)}>
              {ctx.t("editor.cancel")}
            </button>
            <button type="button" class="ait-btn" onClick={save}>
              {ctx.t("editor.save")}
            </button>
          </div>
        </div>
      )}
    </Show>
  )
}

// ---------------------------------------------------------------- hover card

function HoverCard() {
  const ctx = usePlugin<typeof definition>()
  const m = manager()

  const note = (): Note | undefined => {
    const hover = m.hover()
    if (!hover) return undefined
    return m.notes().find((entry) => entry.id === hover.noteId)
  }

  const position = () => {
    const hover = m.hover()
    if (!hover || !note()) return undefined
    const width = 320
    return {
      top: clamp(hover.y + 14, 8, window.innerHeight - 280),
      left: clamp(hover.x - width / 2, 8, window.innerWidth - width - 8),
    }
  }

  const commit = () => {
    const hover = m.hover()
    if (!hover) return
    m.addComment(hover.noteId, m.hoverDraft())
  }

  return (
    <Show when={m.reviewing() && m.hover() && note() && position()}>
      {(place) => (
        <div
          data-annotate-it="hover-card"
          class="ait-card ait-hover"
          style={{ top: `${place().top}px`, left: `${place().left}px` }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div class="ait-quote-preview">{note()!.quote}</div>
          <div class="ait-source">{m.sourceLabel(note()!.source)}</div>
          <div class="ait-card-title">{ctx.t("hover.comments")}</div>
          <Show when={note()!.comments.length > 0} fallback={<div class="ait-hint">{ctx.t("hover.empty")}</div>}>
            <div class="ait-comments">
              <For each={note()!.comments}>
                {(comment) => (
                  <div class="ait-comment">
                    <span class="ait-comment-text">{comment.text}</span>
                    <span class={`ait-badge${comment.sent ? " ait-badge-sent" : ""}`}>
                      {comment.sent ? ctx.t("hover.sent") : ctx.t("hover.pending")}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <div class="ait-card-row">
            <input
              class="ait-mini-input ait-hover-input"
              placeholder={ctx.t("hover.addPlaceholder")}
              value={m.hoverDraft()}
              onInput={(event) => m.setHoverDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                  event.preventDefault()
                  commit()
                } else if (event.key === "Escape") {
                  event.preventDefault()
                  m.closeHover()
                }
              }}
            />
            <MicButton value={() => m.hoverDraft()} onText={(text) => m.setHoverDraft(text)} />
            <button
              type="button"
              class="ait-sendicon"
              disabled={m.hoverDraft().trim() === ""}
              title={ctx.t("card.add")}
              aria-label={ctx.t("card.add")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={commit}
            >
              <ArrowUpGlyph />
            </button>
          </div>
          <div class="ait-card-footer">
            <button type="button" class="ait-btn ait-btn-ghost ait-danger" onClick={() => m.removeNote(note()!.id)}>
              {ctx.t("hover.delete")}
            </button>
          </div>
        </div>
      )}
    </Show>
  )
}

// ---------------------------------------------------------------- settings page

export function AnnotateSettings() {
  const ctx = usePlugin<typeof definition>()
  const m = manager()
  const ui = ctx.ui

  const keys = (command: string) => {
    const parts = ctx.keybinds.keybind(`${ctx.id}.${command}`)
    return parts.length > 0 ? parts : ["—"]
  }

  return (
    <ui.SettingsLayout title={ctx.t("title")} description={ctx.t("settings.description")}>
      <ui.SettingsSection title={ctx.t("settings.behavior")}>
        <ui.SettingsRow
          id="pencil"
          title={ctx.t("settings.pencil")}
          description={ctx.t("settings.pencil.description")}
        >
          <ui.Switch
            label={ctx.t("settings.pencil")}
            hideLabel
            checked={m.pencilEnabled()}
            onChange={(value) => m.setPref("pencil", value)}
          />
        </ui.SettingsRow>
        <ui.SettingsRow
          id="highlights"
          title={ctx.t("settings.highlights")}
          description={ctx.t("settings.highlights.description")}
        >
          <ui.Switch
            label={ctx.t("settings.highlights")}
            hideLabel
            checked={m.highlightsEnabled()}
            onChange={(value) => m.setPref("highlights", value)}
          />
        </ui.SettingsRow>
      </ui.SettingsSection>
      <ui.SettingsSection
        title={ctx.t("settings.actions")}
        footer={
          <div class="ait-settings-actions">
            <ui.Button
              size="small"
              variant="ghost"
              icon="plus"
              onClick={() => m.saveAction(null, ctx.t("settings.action.new"), ctx.t("settings.action.new"))}
            >
              {ctx.t("settings.action.add")}
            </ui.Button>
            <ui.Button size="small" variant="ghost" icon="reset" onClick={() => m.resetActions()}>
              {ctx.t("settings.action.reset")}
            </ui.Button>
          </div>
        }
      >
        <For each={m.actions()}>
          {(action) => (
            <ui.SettingsRow
              id={action.id}
              title={
                <input
                  class="ait-input ait-settings-input"
                  value={action.label}
                  aria-label={ctx.t("editor.label")}
                  onInput={(event) => m.saveAction(action.id, event.currentTarget.value, action.text)}
                />
              }
              description={
                <input
                  class="ait-input ait-settings-input"
                  value={action.text}
                  aria-label={ctx.t("editor.phrase")}
                  onInput={(event) => m.saveAction(action.id, action.label, event.currentTarget.value)}
                />
              }
            >
              <ui.IconButton
                icon="trash"
                variant="ghost-muted"
                size="small"
                label={ctx.t("settings.action.delete")}
                onClick={() => m.removeAction(action.id)}
              />
            </ui.SettingsRow>
          )}
        </For>
      </ui.SettingsSection>
      <ui.SettingsSection title={ctx.t("settings.keys")}>
        <ui.SettingsRow
          id="key-toggle"
          title={ctx.t("settings.keys.toggle")}
          description={ctx.t("settings.keys.description")}
        >
          <ui.Keybind keys={keys("toggle")} />
        </ui.SettingsRow>
        <ui.SettingsRow id="key-clear" title={ctx.t("settings.keys.clear")}>
          <ui.Keybind keys={keys("clear")} />
        </ui.SettingsRow>
      </ui.SettingsSection>
    </ui.SettingsLayout>
  )
}

// ---------------------------------------------------------------- overlay root

export function AnnotateOverlay() {
  const m = manager()
  // Repaint highlights whenever notes or hover change.
  createEffect(() => {
    m.paintTick()
    m.hover()
    m.schedulePaint()
  })
  return (
    <Portal>
      <StandbyPencil />
      <ReviewPanel />
      <ChipMenu />
      <ActionEditor />
      <HoverCard />
    </Portal>
  )
}