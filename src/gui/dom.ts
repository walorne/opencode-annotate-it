/**
 * DOM coupling: selection reading, geometry, and annotation anchors.
 *
 * Chat anchors mirror the app's own quote source: exact text offsets inside a
 * stable `[data-timeline-part-id]` part, so a highlight survives re-renders and
 * virtualization. Document anchors are text + surrounding context, re-found by
 * search, because preview bodies have no stable part ids.
 */

import type { ChatPiece, DocAnchor, NoteSource } from "./definition"

export const TIMELINE_SELECTOR = '[data-timeline="next"]'
/** The scroll root that owns every timeline row (rows themselves carry TIMELINE_SELECTOR). */
export const TIMELINE_ROOT_SELECTOR = '[data-slot="session-timeline-scroll"]'
export const UI_SELECTOR = "[data-annotate-it]"
const EDITABLE_SELECTOR =
  'textarea, input, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]'

export type SelectionTarget = {
  text: string
  /** Union box of the selection, viewport pixels. */
  rect: { top: number; left: number; right: number; bottom: number }
  /** First line box, for centering the quick bar. */
  line: { top: number; left: number; right: number; bottom: number }
  range: Range
  source: NoteSource
}

export function normalizeQuote(text: string) {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/^[ \t]*[│▌>][ \t]*/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function selectionRects(range: Range) {
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0)
  if (rects.length === 0) {
    const fallback = range.getBoundingClientRect()
    if (fallback.width > 0 && fallback.height > 0) rects.push(fallback)
  }
  return rects
}

function boxes(range: Range) {
  const rects = selectionRects(range)
  if (rects.length === 0) return null
  let top = Infinity
  let left = Infinity
  let right = -Infinity
  let bottom = -Infinity
  let firstTop = Infinity
  for (const rect of rects) {
    top = Math.min(top, rect.top)
    left = Math.min(left, rect.left)
    right = Math.max(right, rect.right)
    bottom = Math.max(bottom, rect.bottom)
    firstTop = Math.min(firstTop, rect.top)
  }
  const lineRects = rects.filter((rect) => Math.abs(rect.top - firstTop) <= 4)
  return {
    rect: { top, left, right, bottom },
    line: {
      top: firstTop,
      left: Math.min(...lineRects.map((r) => r.left)),
      right: Math.max(...lineRects.map((r) => r.right)),
      bottom: Math.max(...lineRects.map((r) => r.bottom)),
    },
  }
}

/** The file path of the side-pane tab that owns `element`, when it is a file tab. */
export function documentPathOf(element: Element): string | null {
  const pane = element.closest("[data-pane-content]")
  if (!pane) return null
  const paneId = pane.getAttribute("data-pane-content")
  const strip = paneId
    ? pane.querySelector(`[data-pane-strip="${CSS.escape(paneId)}"]`)
    : pane.querySelector("[data-pane-strip]")
  const trigger = strip?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"][data-pane-tab]')
  const key = trigger?.getAttribute("data-pane-tab") ?? ""
  // Host file tab keys are `file://` + the encoded absolute path.
  if (!key.startsWith("file://")) return null
  const rest = key.slice("file://".length)
  const segments = rest.split("/").filter((s) => s !== "")
  if (segments.length === 0) return null
  try {
    return "/" + segments.map(decodeURIComponent).join("/")
  } catch {
    return null
  }
}

/** The live selection when it sits in annotatable content and out of every control. */
export function readSelection(): SelectionTarget | null {
  let selection: Selection | null
  try {
    selection = window.getSelection()
  } catch {
    return null
  }
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  const node = range.commonAncestorContainer
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement
  if (!element || !element.closest) return null
  if (element.closest(UI_SELECTOR)) return null
  if (element.closest(EDITABLE_SELECTOR)) return null

  const inChat = (() => {
    if (element.closest(TIMELINE_SELECTOR)) return true
    // A selection spanning several rows has its common ancestor above the rows:
    // ask the timeline root whether the range touches it instead.
    const root = document.querySelector(TIMELINE_ROOT_SELECTOR)
    return !!root && range.intersectsNode(root)
  })()
  let source: NoteSource
  if (inChat) {
    source = { kind: "chat" }
  } else {
    // Documents: anything selectable inside a side pane that shows a file tab.
    const pane = element.closest("[data-pane-content]")
    const path = pane ? documentPathOf(element) : null
    if (!path) return null
    source = { kind: "document", path }
  }

  const text = normalizeQuote(selection.toString())
  if (!text) return null
  const box = boxes(range)
  if (!box) return null
  return { text, rect: box.rect, line: box.line, range: range.cloneRange(), source }
}

// ---------------------------------------------------------------- text maps

export type TextMap = {
  root: Element | ShadowRoot
  text: string
  segments: { node: Text; start: number; end: number }[]
}

/** Concatenated text of a root plus the mapping back to its text nodes, piercing shadow roots. */
export function textMap(root: Element | ShadowRoot): TextMap | null {
  let text = ""
  const segments: { node: Text; start: number; end: number }[] = []
  const walk = (container: Element | ShadowRoot) => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node instanceof Element) {
          const parent = node.parentElement
          if (parent?.closest(UI_SELECTOR)) return NodeFilter.FILTER_REJECT
          if (node instanceof HTMLElement && /^(TEXTAREA|INPUT|SELECT)$/.test(node.tagName))
            return NodeFilter.FILTER_REJECT
          return node.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
        }
        const parent = (node as Text).parentElement
        if (!parent || parent.closest(`${UI_SELECTOR}, ${EDITABLE_SELECTOR}`)) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })
    let node: Node | null
    while ((node = walker.nextNode())) {
      if (node instanceof Text) {
        const value = node.nodeValue ?? ""
        if (value !== "") {
          segments.push({ node, start: text.length, end: text.length + value.length })
          text += value
        }
      } else if (node instanceof Element && node.shadowRoot) {
        walk(node.shadowRoot)
      }
    }
  }
  walk(root)
  if (text === "") return null
  return { root, text, segments }
}

function rangeFromOffsets(map: TextMap, start: number, end: number): Range | null {
  const locate = (offset: number) => {
    for (const segment of map.segments) {
      if (offset >= segment.start && offset <= segment.end) {
        return {
          node: segment.node,
          offset: Math.max(0, Math.min(offset - segment.start, segment.node.nodeValue?.length ?? 0)),
        }
      }
    }
    return null
  }
  const from = locate(start)
  const to = locate(end)
  if (!from || !to) return null
  try {
    const range = document.createRange()
    range.setStart(from.node, from.offset)
    range.setEnd(to.node, to.offset)
    return range
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- chat anchors

/** Capture exact offsets in stable timeline parts for the selected range. */
export function captureChatPieces(range: Range): ChatPiece[] {
  type MutablePiece = {
    partID: string
    revealID: string
    body?: string
    start: number
    end: number
    text: string
  }
  const pieces: MutablePiece[] = []
  const indexes = new Map<Element, Map<Text, number>>()
  const root = range.commonAncestorContainer
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (!(node instanceof Text)) continue
    const parent = node.parentElement
    if (!parent || parent.closest(UI_SELECTOR)) continue
    const part = parent.closest("[data-timeline-part-id]")
    const partID = part?.getAttribute("data-timeline-part-id")
    const revealID = part?.closest("[data-message-id]")?.getAttribute("data-message-id")
    if (!part || !partID || !revealID) continue
    const body = parent.closest('[data-slot="text-part-body"], [data-slot="user-message-text"]')
    const container = body ?? part
    let index = indexes.get(container)
    if (!index) {
      index = new Map()
      let offset = 0
      const inner = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
      let textNode: Node | null
      while ((textNode = inner.nextNode())) {
        const t = textNode as Text
        index.set(t, offset)
        offset += t.nodeValue?.length ?? 0
      }
      indexes.set(container, index)
    }
    const base = index.get(node)
    if (base === undefined) continue
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : (node.nodeValue?.length ?? 0)
    if (end <= start) continue
    const piece: MutablePiece = {
      partID,
      revealID,
      body: body ? `[data-slot="${body.getAttribute("data-slot")}"]` : undefined,
      start: base + start,
      end: base + end,
      text: (node.nodeValue ?? "").slice(start, end),
    }
    const previous = pieces.at(-1)
    if (
      previous &&
      previous.partID === piece.partID &&
      previous.body === piece.body &&
      previous.end === piece.start
    ) {
      previous.end = piece.end
      previous.text += piece.text
      continue
    }
    pieces.push(piece)
  }
  return pieces
}

/** Resolve one chat piece back to a live range, or undefined when the part changed. */
export function resolveChatPiece(root: Element, piece: ChatPiece): Range | null {
  const part = root.querySelector(`[data-timeline-part-id="${CSS.escape(piece.partID)}"]`)
  if (!part) return null
  const container = piece.body ? part.querySelector(piece.body) : part
  if (!container) return null
  const nodes: { node: Text; start: number; end: number }[] = []
  let offset = 0
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const t = node as Text
    nodes.push({ node: t, start: offset, end: offset + (t.nodeValue?.length ?? 0) })
    offset += t.nodeValue?.length ?? 0
  }
  const start = nodes.find((item) => item.start <= piece.start && item.end > piece.start)
  const end = nodes.find((item) => item.start < piece.end && item.end >= piece.end)
  if (!start || !end) return null
  try {
    const range = document.createRange()
    range.setStart(start.node, piece.start - start.start)
    range.setEnd(end.node, piece.end - end.start)
    // A changed part must never highlight unrelated text at the old offset.
    return range.toString() === piece.text ? range : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- document anchors

/** The preview body that owns a document selection: the pane's scrollable content. */
export function documentRootOf(element: Element): Element | null {
  return element.closest("[data-pane-content]")
}

export function captureDocAnchor(range: Range, path: string): DocAnchor | null {
  const element =
    range.commonAncestorContainer.nodeType === 1
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement
  const root = element ? documentRootOf(element) : null
  if (!root) return null
  const map = textMap(root)
  if (!map) return null
  const quote = range.toString()
  if (!quote) return null
  // Locate the occurrence the live selection sits at.
  const selectionRect = range.getBoundingClientRect()
  let chosen = -1
  let index = map.text.indexOf(quote)
  while (index >= 0) {
    const candidate = rangeFromOffsets(map, index, index + quote.length)
    if (chosen < 0) chosen = index
    if (candidate) {
      const rect = candidate.getBoundingClientRect()
      if (Math.abs(rect.top - selectionRect.top) < 2 && Math.abs(rect.left - selectionRect.left) < 2) {
        chosen = index
        break
      }
    }
    index = map.text.indexOf(quote, index + 1)
  }
  if (chosen < 0) return null
  return {
    path,
    text: quote,
    prefix: map.text.slice(Math.max(0, chosen - 40), chosen),
    suffix: map.text.slice(chosen + quote.length, chosen + quote.length + 40),
  }
}

/** Re-find a document quote in whichever pane currently shows its file. */
export function resolveDocAnchor(anchor: DocAnchor): Range | null {
  const panes = document.querySelectorAll("[data-pane-content]")
  for (const pane of Array.from(panes)) {
    const trigger = pane.querySelector<HTMLElement>('[role="tab"][aria-selected="true"][data-pane-tab]')
    const key = trigger?.getAttribute("data-pane-tab") ?? ""
    if (!key.startsWith("file://")) continue
    const path = documentPathOf(pane as Element)
    if (path !== anchor.path) continue
    const map = textMap(pane as Element)
    if (!map) continue
    const candidates: number[] = []
    let index = map.text.indexOf(anchor.text)
    while (index >= 0 && candidates.length < 30) {
      candidates.push(index)
      index = map.text.indexOf(anchor.text, index + 1)
    }
    if (candidates.length === 0) continue
    let chosen = candidates[0]
    for (const candidate of candidates) {
      const before = map.text.slice(Math.max(0, candidate - 40), candidate)
      const after = map.text.slice(candidate + anchor.text.length, candidate + anchor.text.length + 40)
      if (
        (!anchor.prefix || before.endsWith(anchor.prefix)) &&
        (!anchor.suffix || after.startsWith(anchor.suffix))
      ) {
        chosen = candidate
        break
      }
    }
    return rangeFromOffsets(map, chosen, chosen + anchor.text.length)
  }
  return null
}