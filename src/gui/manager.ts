/**
 * The annotation manager: per-session review mode, the quick-action dictionary,
 * the note queue (native composer quotes), highlights, and send tracking.
 */

import { createSignal } from "solid-js"
import type { SetupContext } from "@opencode/plugin/gui"
import type { definition, Note, NoteSource, QuickAction } from "./definition"
import {
  captureChatPieces,
  captureDocAnchor,
  captureTextAnchor,
  normalizeQuote,
  readSelection,
  resolveChatPiece,
  resolveDocAnchor,
  resolveTextAnchor,
  TIMELINE_ROOT_SELECTOR,
  TIMELINE_SELECTOR,
  UI_SELECTOR,
  type SelectionTarget,
} from "./dom"

export type Ctx = SetupContext<typeof definition>

export type HoverState = { noteId: string; x: number; y: number }
export type ChipMenuState = { actionId: string; x: number; y: number; confirming: boolean }
export type EditorState = { id: string | null; label: string; text: string; x: number; y: number }

const PENDING_HIGHLIGHT = "annotate-it-pending"
const SENT_HIGHLIGHT = "annotate-it-sent"
const HOVER_HIGHLIGHT = "annotate-it-hover"
const SELECTION_HIGHLIGHT = "annotate-it-selection"

function highlightSupported() {
  return typeof Highlight === "function" && typeof CSS !== "undefined" && !!CSS.highlights
}

export function createManager(ctx: Ctx) {
  // ------------------------------------------------------------ reactive state

  const [target, setTarget] = createSignal<SelectionTarget | null>(null)
  const [customOpen, setCustomOpen] = createSignal(false)
  const [chipMenu, setChipMenu] = createSignal<ChipMenuState | null>(null)
  const [editor, setEditor] = createSignal<EditorState | null>(null)
  const [hover, setHover] = createSignal<HoverState | null>(null)
  const [hoverDraft, setHoverDraft] = createSignal("")
  const [customDraft, setCustomDraft] = createSignal("")
  /** Bumped to repaint highlights after note changes. */
  const [paintTick, setPaintTick] = createSignal(0)

  /** Live ranges per note id, rebuilt on every repaint. */
  const ranges = new Map<string, Range[]>()
  let hoverSuppressUntil = 0
  let hoverTimer: ReturnType<typeof setTimeout> | undefined
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let pressing = false
  /** Recent press inside our own UI: the host must not clear the selection for it. */
  let uiInteractUntil = 0
  let repaintFrame: number | undefined

  // ------------------------------------------------------------ session helpers

  const session = () => ctx.sessions.current()

  const reviewing = () => {
    const current = session()
    if (!current) return false
    return ctx.stores.mode(current)?.value?.reviewing ?? false
  }

  const notes = (): readonly Note[] => {
    const current = session()
    if (!current) return []
    return ctx.stores.notes(current)?.value?.list ?? []
  }

  const updateNotes = (transform: (list: readonly Note[]) => readonly Note[]) => {
    const current = session()
    if (!current) return
    const store = ctx.stores.notes(current)
    if (!store) return
    store.update((draft) => {
      draft.list = transform(draft.list) as typeof draft.list
    })
    repaint()
  }

  const setReviewing = (value: boolean) => {
    const current = session()
    if (!current) return
    ctx.stores.mode(current)?.update((draft) => {
      draft.reviewing = value
    })
    if (!value) {
      setTarget(null)
      setCustomOpen(false)
      setChipMenu(null)
      setEditor(null)
      closeHover()
    }
    syncReviewClass()
  }

  const syncReviewClass = () => {
    document.documentElement.classList.toggle("annotate-it-review", reviewing())
  }

  // ------------------------------------------------------------ quick actions

  const defaultActions = (): QuickAction[] =>
    ["yes", "no", "prove", "more", "think"].map((key) => ({
      id: `default-${key}`,
      label: ctx.t(`action.${key}.label`),
      text: ctx.t(`action.${key}.text`),
    }))

  const actions = (): readonly QuickAction[] => {
    const stored = ctx.stores.prefs.value.actions
    if (stored !== null) return stored
    const seeded = defaultActions()
    ctx.stores.prefs.update((draft) => {
      draft.actions = seeded as typeof draft.actions
    })
    return seeded
  }

  const saveAction = (id: string | null, label: string, text: string) => {
    const phrase = text.trim()
    if (!phrase) return
    const chip = label.trim() || phrase
    ctx.stores.prefs.update((draft) => {
      const list = draft.actions ?? defaultActions()
      draft.actions = (id
        ? list.map((entry) => (entry.id === id ? { ...entry, label: chip, text: phrase } : entry))
        : [...list, { id: `user-${Date.now()}`, label: chip, text: phrase }]) as typeof draft.actions
    })
    setEditor(null)
    setChipMenu(null)
  }

  const removeAction = (id: string) => {
    ctx.stores.prefs.update((draft) => {
      draft.actions = (draft.actions ?? defaultActions()).filter(
        (entry) => entry.id !== id,
      ) as typeof draft.actions
    })
    setChipMenu(null)
    setEditor(null)
  }

  const resetActions = () => {
    ctx.stores.prefs.update((draft) => {
      draft.actions = defaultActions() as typeof draft.actions
    })
  }

  const pencilEnabled = () => ctx.stores.prefs.value.pencil ?? true
  const highlightsEnabled = () => ctx.stores.prefs.value.highlights ?? true
  const accent = () => ctx.stores.prefs.value.accent ?? "#d97757"

  const setPref = (key: "pencil" | "highlights", value: boolean) => {
    ctx.stores.prefs.update((draft) => {
      draft[key] = value
    })
    if (key === "highlights") repaint()
  }

  const setAccent = (value: string) => {
    ctx.stores.prefs.update((draft) => {
      draft.accent = value
    })
    repaint()
  }

  // ------------------------------------------------------------ attaching notes

  const composer = () => ctx.screen.current()?.composer

  const sourceLabel = (source: NoteSource) => {
    switch (source.kind) {
      case "document":
        return ctx.t("source.document", { path: source.path })
      case "terminal":
        return ctx.t("source.terminal")
      case "browser": {
        let host = source.url
        try {
          host = new URL(source.url).host
        } catch {
          /* keep the raw url */
        }
        return ctx.t("source.browser", { host })
      }
      default:
        return ctx.t("source.chat")
    }
  }

  const sourceSubject = (source: NoteSource) => {
    switch (source.kind) {
      case "document":
        return ctx.t("subject.document", { path: source.path })
      case "terminal":
        return ctx.t("subject.terminal")
      case "browser":
        return ctx.t("subject.browser", { url: source.url })
      default:
        return ctx.t("subject.chat")
    }
  }

  const sourceIcon = (source: NoteSource): "globe" | "terminal" | "outline-quote" =>
    source.kind === "browser" ? "globe" : source.kind === "terminal" ? "terminal" : "outline-quote"

  /** Attach one quote+comment to the composer and record the annotation. */
  const attachNote = (quote: string, comment: string, source: NoteSource, range: Range | null, keepEditor: boolean) => {
    const comp = composer()
    if (!comp || !comp.quotable()) {
      ctx.toast.show({ variant: "error", title: ctx.t("toast.unquotable") })
      return false
    }
    const id = crypto.randomUUID()
    const chat = source.kind === "chat" && range ? captureChatPieces(range) : undefined
    const doc = source.kind === "document" && range ? captureDocAnchor(range, source.path) : undefined
    // Shadow-root chat selections (diffs, code) have no part offsets; anchor by text search.
    const textAnchor =
      source.kind === "chat" && range && (!chat || chat.length === 0)
        ? (() => {
            const root = document.querySelector(TIMELINE_ROOT_SELECTOR)
            return root ? captureTextAnchor(range, root) : null
          })()
        : undefined
    comp.attach({
      type: "quote",
      commentID: id,
      text: quote,
      ...(comment ? { comment } : {}),
      source: { label: sourceLabel(source), icon: sourceIcon(source), subject: sourceSubject(source) },
    })
    updateNotes((list) => [
      ...list,
      {
        id,
        quote,
        source,
        ...(chat && chat.length ? { chat } : {}),
        ...(doc ? { doc } : {}),
        ...(textAnchor ? { textAnchor } : {}),
        comments: comment ? [{ text: comment, sent: false }] : [],
        created: Date.now(),
      },
    ])
    hoverSuppressUntil = Date.now() + 450
    closeHover()
    try {
      window.getSelection()?.removeAllRanges()
    } catch {
      /* ignore */
    }
    setTarget(null)
    setCustomOpen(false)
    setCustomDraft("")
    if (!keepEditor) comp.focus()
    return true
  }

  /** A quick reply chip: attach the preset phrase as the quote's comment. */
  const quickReply = (action: QuickAction) => {
    const current = target()
    if (!current) return
    attachNote(current.text, action.text, current.source, current.range, false)
  }

  /** Plain quote: attach without a comment and open the native comment editor at the source. */
  const plainQuote = () => {
    const current = target()
    if (!current) return
    const rect = current.line
    const comp = composer()
    const ok = attachNote(current.text, "", current.source, current.range, true)
    if (!ok || !comp) return
    const note = notes().at(-1)
    if (!note) return
    comp.focus(note.id, {
      anchor: (size) => {
        const width = size.width
        const left = Math.min(Math.max(rect.left + (rect.right - rect.left) / 2 - width / 2, 8), window.innerWidth - width - 8)
        const top = Math.max(rect.top - size.height - 8, 8)
        return { top, left }
      },
    })
  }

  const addCustom = (text: string) => {
    const current = target()
    const phrase = text.trim()
    if (!current || !phrase) return false
    return attachNote(current.text, phrase, current.source, current.range, false)
  }

  /** Add a comment to an existing note: update the pending chip, or re-quote a sent passage. */
  const addComment = (noteId: string, text: string) => {
    const phrase = text.trim()
    if (!phrase) return
    const note = notes().find((entry) => entry.id === noteId)
    if (!note) return
    const pending = note.comments.some((comment) => !comment.sent)
    if (pending) {
      composer()?.update(noteId, {
        comment: [...note.comments.filter((c) => !c.sent).map((c) => c.text), phrase].join("\n\n"),
      })
      updateNotes((list) =>
        list.map((entry) =>
          entry.id === noteId
            ? { ...entry, comments: [...entry.comments, { text: phrase, sent: false }] }
            : entry,
        ),
      )
    } else {
      const range = ranges.get(noteId)?.[0] ?? null
      attachNote(note.quote, phrase, note.source, range, false)
    }
    setHoverDraft("")
    hoverSuppressUntil = Date.now() + 450
  }

  const removeNote = (noteId: string) => {
    const note = notes().find((entry) => entry.id === noteId)
    if (!note) return
    if (note.comments.some((comment) => !comment.sent)) composer()?.detach(noteId)
    updateNotes((list) => list.filter((entry) => entry.id !== noteId))
    ranges.delete(noteId)
    closeHover()
  }

  const clearAll = async () => {
    const ok = await ctx.dialogs.confirm({
      title: ctx.t("clear.title"),
      confirm: ctx.t("clear.confirm"),
      cancel: ctx.t("clear.cancel"),
      danger: true,
    })
    if (!ok) return
    for (const note of notes()) {
      if (note.comments.some((comment) => !comment.sent)) composer()?.detach(note.id)
    }
    updateNotes(() => [])
    ranges.clear()
    closeHover()
  }

  const pendingCount = () =>
    notes().filter((note) => note.comments.some((comment) => !comment.sent)).length

  // ------------------------------------------------------------ send tracking

  /** Mark notes sent when a user message carries their quote text. */
  const trackSent = (sessionID: string, text: string) => {
    const current = session()
    if (!current || current.id !== sessionID) return
    const pending = notes().filter((note) => note.comments.some((comment) => !comment.sent))
    if (pending.length === 0) return
    const sentIds: string[] = []
    for (const note of pending) {
      const expected = note.quote
        .split("\n")
        .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
        .join("\n")
      if (text.includes(expected) || text.includes(note.quote)) sentIds.push(note.id)
    }
    if (sentIds.length === 0) return
    updateNotes((list) =>
      list.map((note) =>
        sentIds.includes(note.id)
          ? { ...note, comments: note.comments.map((comment) => ({ ...comment, sent: true })) }
          : note,
      ),
    )
  }

  // ------------------------------------------------------------ highlights

  const repaint = () => {
    setPaintTick((value) => value + 1)
  }

  const resolveNoteRanges = (note: Note): Range[] => {
    if (note.source.kind === "browser" || note.source.kind === "terminal") return []
    if (note.source.kind === "document") {
      const range = note.doc ? resolveDocAnchor(note.doc) : null
      return range ? [range] : []
    }
    const root = document.querySelector(TIMELINE_ROOT_SELECTOR)
    if (!root) return []
    if (note.textAnchor) {
      const range = resolveTextAnchor(root, note.textAnchor)
      return range ? [range] : []
    }
    if (!note.chat) return []
    const result: Range[] = []
    for (const piece of note.chat) {
      const range = resolveChatPiece(root, piece)
      if (range) result.push(range)
    }
    return result
  }

  const paintHighlights = () => {
    if (!highlightSupported()) return
    if (!highlightsEnabled()) {
      try {
        CSS.highlights.delete(PENDING_HIGHLIGHT)
        CSS.highlights.delete(SENT_HIGHLIGHT)
        CSS.highlights.delete(HOVER_HIGHLIGHT)
        CSS.highlights.delete(SELECTION_HIGHLIGHT)
      } catch {
        /* ignore */
      }
      return
    }
    const pending: Range[] = []
    const sent: Range[] = []
    const hovered: Range[] = []
    const hoverId = hover()?.noteId
    ranges.clear()
    for (const note of notes()) {
      const resolved = resolveNoteRanges(note)
      if (resolved.length === 0) continue
      ranges.set(note.id, resolved)
      const isPending = note.comments.some((comment) => !comment.sent)
      if (note.id === hoverId) hovered.push(...resolved)
      if (isPending) pending.push(...resolved)
      else if (note.comments.length > 0) sent.push(...resolved)
    }
    try {
      CSS.highlights.set(PENDING_HIGHLIGHT, new Highlight(...pending))
      CSS.highlights.set(SENT_HIGHLIGHT, new Highlight(...sent))
      CSS.highlights.set(HOVER_HIGHLIGHT, new Highlight(...hovered))
      // Focusing the panel's field collapses the native selection; keep the
      // passage marked while the panel is open.
      const active = target()
      const selectionRange =
        active?.range && active.range.startContainer.isConnected ? [active.range] : []
      CSS.highlights.set(SELECTION_HIGHLIGHT, new Highlight(...selectionRange))
    } catch {
      /* a missing registry only removes the decoration */
    }
  }

  const schedulePaint = () => {
    if (repaintFrame !== undefined) return
    repaintFrame = requestAnimationFrame(() => {
      repaintFrame = undefined
      paintHighlights()
    })
  }

  // ------------------------------------------------------------ hover card

  const closeHover = () => {
    if (hoverTimer) clearTimeout(hoverTimer)
    if (hideTimer) clearTimeout(hideTimer)
    hoverTimer = undefined
    hideTimer = undefined
    setHover(null)
    setHoverDraft("")
  }

  const hitNote = (x: number, y: number): string | null => {
    for (const [noteId, noteRanges] of ranges) {
      for (const range of noteRanges) {
        if (!range.startContainer.isConnected) continue
        for (const rect of range.getClientRects()) {
          if (rect.width === 0 || rect.height === 0) continue
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return noteId
        }
      }
    }
    return null
  }

  const onMouseMove = (event: MouseEvent) => {
    if (!reviewing()) return
    if (Date.now() < hoverSuppressUntil) return
    const element = event.target instanceof Element ? event.target : null
    if (element?.closest(UI_SELECTOR)) {
      // Moving inside the card keeps it open.
      if (hover() && element?.closest('[data-annotate-it="hover-card"]')) {
        if (hideTimer) clearTimeout(hideTimer)
        hideTimer = undefined
        return
      }
      return
    }
    const noteId = hitNote(event.clientX, event.clientY)
    if (!noteId) {
      if (hover() && !hideTimer) {
        hideTimer = setTimeout(() => {
          hideTimer = undefined
          setHover(null)
          setHoverDraft("")
          repaint()
        }, 260)
      }
      return
    }
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = undefined
    }
    const current = hover()
    if (current?.noteId === noteId) return
    if (hoverTimer) clearTimeout(hoverTimer)
    hoverTimer = setTimeout(() => {
      hoverTimer = undefined
      setHover({ noteId, x: event.clientX, y: event.clientY })
      setHoverDraft("")
      repaint()
    }, 300)
  }

  // ------------------------------------------------------------ selection watch

  /** Targets coming from outside the document DOM (terminal copy, browser pane). */
  const isExternal = (t: SelectionTarget | null) =>
    !!t && (t.source.kind === "browser" || t.source.kind === "terminal")

  const setExternalTarget = (t: SelectionTarget | null) => setTarget(t)
  const clearExternalTarget = () => {
    if (isExternal(target())) setTarget(null)
  }
  const isPressing = () => pressing

  // The terminal is a canvas: its selection reaches the app through the copy
  // event's clipboardData. Offer the copied passage for annotation at once.
  const onCopy = (event: ClipboardEvent) => {
    const element = event.target instanceof Element ? event.target : null
    const wrapper = element?.closest('[id^="terminal-wrapper"]')
    if (!wrapper) return
    const text = normalizeQuote(event.clipboardData?.getData("text/plain") ?? "")
    if (!text) return
    const rect = wrapper.getBoundingClientRect()
    setTarget({
      text,
      rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
      line: { top: rect.top + 6, left: rect.left + 6, right: rect.left + 220, bottom: rect.top + 24 },
      range: null,
      source: { kind: "terminal" },
    })
  }

  // A plain click on a highlighted passage opens its card (no selection).
  const onClick = (event: MouseEvent) => {
    if (!reviewing() || event.defaultPrevented) return
    const element = event.target instanceof Element ? event.target : null
    if (element?.closest(UI_SELECTOR)) return
    if (!(window.getSelection()?.isCollapsed ?? true)) return
    const noteId = hitNote(event.clientX, event.clientY)
    if (!noteId) return
    if (hoverTimer) clearTimeout(hoverTimer)
    if (hideTimer) clearTimeout(hideTimer)
    hoverTimer = undefined
    hideTimer = undefined
    hoverSuppressUntil = Date.now() + 450
    setHover({ noteId, x: event.clientX, y: event.clientY })
    setHoverDraft("")
    repaint()
  }

  const readTarget = () => {
    if (pressing) {
      setTarget(null)
      return
    }
    const dom = readSelection()
    // An external target (browser/terminal) has no document selection to read.
    if (!dom && isExternal(target())) return
    setTarget(dom)
  }

  const onSelectionChange = () => {
    const collapsed = window.getSelection()?.isCollapsed ?? true
    if (collapsed) {
      // Focus inside our own panel (its textarea) collapses the document
      // selection; the panel keeps its passage in that case. A press on our
      // UI also keeps it: the host's quote controller clears selections on
      // outside presses, and must not eat the passage we are acting on.
      const active = document.activeElement
      if (active instanceof Element && active.closest(UI_SELECTOR)) return
      if (Date.now() < uiInteractUntil) return
      if (isExternal(target())) return
      // A collapsed selection with a drafted comment still saves the quote.
      if (target() && customDraft().trim()) {
        addCustom(customDraft())
        return
      }
      setTarget(null)
      return
    }
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settleTimer = undefined
      readTarget()
    }, 150)
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    const element = event.target instanceof Element ? event.target : null
    if (element?.closest(UI_SELECTOR)) {
      // Keep the host's quote controller from seeing presses on our UI: it
      // clears the live selection on any outside press, which would eat the
      // passage the pencil/panel is acting on.
      uiInteractUntil = Date.now() + 500
      event.stopPropagation()
      return
    }
    // Click away saves a typed/dictated comment as a quote (DSH behavior);
    // an empty field just dismisses the panel.
    if (target() && customDraft().trim()) addCustom(customDraft())
    if (isExternal(target())) setTarget(null)
    pressing = true
  }

  const onPointerUp = () => {
    if (!pressing) return
    pressing = false
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settleTimer = undefined
      readTarget()
    }, 10)
  }

  // A press can end without a pointerup reaching the document (release outside
  // the window, a native drag, a removed node); these release it too, so a
  // stuck `pressing` never blocks selection reading.
  const onPointerMove = (event: PointerEvent) => {
    if (pressing && (event.buttons & 1) === 0) onPointerUp()
  }
  const onBlur = () => onPointerUp()

  // ------------------------------------------------------------ wiring

  const start = () => {
    document.addEventListener("selectionchange", onSelectionChange)
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("pointerup", onPointerUp, true)
    document.addEventListener("pointercancel", onPointerUp, true)
    document.addEventListener("pointermove", onPointerMove, { capture: true, passive: true })
    document.addEventListener("dragend", onPointerUp, true)
    document.addEventListener("contextmenu", onPointerUp, true)
    window.addEventListener("blur", onBlur)
    document.addEventListener("mousemove", onMouseMove, { passive: true })
    document.addEventListener("click", onClick)
    document.addEventListener("copy", onCopy)

    const observer = new MutationObserver(() => schedulePaint())
    let observedRoots: Element[] = []
    const refreshRoots = () => {
      const roots: Element[] = []
      const timeline = document.querySelector(TIMELINE_ROOT_SELECTOR)
      if (timeline) roots.push(timeline)
      for (const pane of Array.from(document.querySelectorAll("[data-pane-content]"))) roots.push(pane)
      const same =
        roots.length === observedRoots.length && roots.every((root, index) => root === observedRoots[index])
      if (same) return
      observer.disconnect()
      observedRoots = roots
      for (const root of roots) {
        observer.observe(root, { childList: true, subtree: true, characterData: true })
      }
    }
    refreshRoots()
    // Panes and the timeline mount after the plugin starts, and come and go with
    // routing; watch the body's structure to pick up new roots.
    const bodyObserver = new MutationObserver(() => {
      refreshRoots()
      schedulePaint()
    })
    bodyObserver.observe(document.body, { childList: true, subtree: true })

    const resize = () => schedulePaint()
    window.addEventListener("resize", resize)
    document.addEventListener("scroll", resize, { capture: true, passive: true })

    syncReviewClass()
    paintHighlights()

    return () => {
      document.removeEventListener("selectionchange", onSelectionChange)
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("pointerup", onPointerUp, true)
      document.removeEventListener("pointercancel", onPointerUp, true)
      document.removeEventListener("pointermove", onPointerMove, true)
      document.removeEventListener("dragend", onPointerUp, true)
      document.removeEventListener("contextmenu", onPointerUp, true)
      window.removeEventListener("blur", onBlur)
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("click", onClick)
      document.removeEventListener("copy", onCopy)
      observer.disconnect()
      bodyObserver.disconnect()
      window.removeEventListener("resize", resize)
      document.removeEventListener("scroll", resize, true)
      if (settleTimer) clearTimeout(settleTimer)
      if (hoverTimer) clearTimeout(hoverTimer)
      if (hideTimer) clearTimeout(hideTimer)
      if (repaintFrame !== undefined) cancelAnimationFrame(repaintFrame)
      if (highlightSupported()) {
        CSS.highlights.delete(PENDING_HIGHLIGHT)
        CSS.highlights.delete(SENT_HIGHLIGHT)
        CSS.highlights.delete(HOVER_HIGHLIGHT)
        CSS.highlights.delete(SELECTION_HIGHLIGHT)
      }
      document.documentElement.classList.remove("annotate-it-review")
    }
  }

  return {
    target,
    clearTarget: () => setTarget(null),
    setExternalTarget,
    clearExternalTarget,
    isPressing,
    cancelTarget: () => {
      setTarget(null)
      setCustomDraft("")
    },
    customOpen,
    setCustomOpen,
    customDraft,
    setCustomDraft,
    chipMenu,
    setChipMenu,
    editor,
    setEditor,
    hover,
    hoverDraft,
    setHoverDraft,
    paintTick,
    session,
    reviewing,
    setReviewing,
    syncReviewClass,
    notes,
    actions,
    saveAction,
    removeAction,
    resetActions,
    pencilEnabled,
    highlightsEnabled,
    setPref,
    accent,
    setAccent,
    quickReply,
    plainQuote,
    addCustom,
    addComment,
    removeNote,
    clearAll,
    pendingCount,
    trackSent,
    repaint,
    schedulePaint,
    closeHover,
    start,
    sourceLabel,
  }
}

export type Manager = ReturnType<typeof createManager>