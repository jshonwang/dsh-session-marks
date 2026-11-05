/**
 * Browser half of the `session-marks` bundle.
 *
 * Proofreading-style annotation for a long transcript: select any snippet of a
 * reply, attach a question to it, and keep annotating. The annotations collect
 * in a bar above the composer; one click turns all of them into a single
 * numbered quote block in the draft, so the follow-up question points at exact
 * passages instead of describing where to look.
 *
 * Two mechanisms make this work without forking the transcript renderer:
 *
 * - Each annotated snippet is stored as a text-quote anchor (row key, character
 *   offsets, the quoted text and its neighbours), then relocated on every
 *   repaint. The Chat view re-renders and pages rows in and out, so a live DOM
 *   `Range` cannot be kept; offsets plus a quote search can.
 * - The highlight is painted with the CSS Custom Highlight API, which draws
 *   ranges without touching the host's DOM.
 *
 * Annotations are a reading aid: they live in this browser, never in the
 * Session log, and reach the model only as the plain text the user chose to
 * send.
 *
 * @module dsh-session-marks/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-marks',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'session-marks';
    /** Storage key prefix; one bucket per Session. */
    const STORAGE_PREFIX = 'dsh-session-marks:v2:';
    /** Custom Highlight registry name shared by every saved annotation. */
    const HIGHLIGHT_NAME = 'dsm-mark';
    /** Separate registry name for the passage being annotated right now. */
    const PENDING_HIGHLIGHT = 'dsm-pending';
    /** Characters of context kept on each side of a quote, for relocation. */
    const CONTEXT_CHARS = 48;
    /** Budget inside the inserted quote block, per passage. */
    const QUOTE_BUDGET = 600;
    /** The row element every anchor hangs off. */
    const ROW_SELECTOR = '[data-chat-node-key]';
    /** Marker attribute on rows, so a stale anchor is cheap to spot. */
    const ROW_KEY_ATTR = 'data-chat-node-key';

    const zh = {
      'pending.selected': '已选中 {count} 字',
      'pending.multi': '一次只能标在同一段内容里',
      'editor.question': '针对这段话的问题',
      'editor.placeholder': '例如：这里为什么加锁？换成乐观锁会怎样？',
      'editor.hint': 'Enter 直接发送 · Shift+Enter 只保存 · Esc 取消',
      'bar.count': '已标注 {count} 处',
      'bar.copy': '复制引用',
      'bar.clear': '清空',
      'bar.remove': '移除这条标注',
      'bar.goto': '跳到这条标注',
      'bar.copied': '引用已复制',
      'bar.failed': '写入失败',
      'bar.noQuestion': '（未填写问题）',
      'quote.intro': '下面是我在这条对话里标注的内容，请针对每一处标注后面的问题逐条回答。',
      'quote.item': '[{index}] 第 {turn} 轮',
      'quote.passage': '原文：',
      'quote.question': '我的问题：',
      'quote.closing': '请按上面的编号逐条回答。'
    };

    const en = {
      'pending.selected': '{count} characters selected',
      'pending.multi': 'Select inside one passage at a time',
      'editor.question': 'Your question about it',
      'editor.placeholder': 'e.g. Why is a lock needed here? What breaks with an optimistic one?',
      'editor.hint': 'Enter sends · Shift+Enter saves only · Esc cancels',
      'bar.count': '{count} annotated',
      'bar.copy': 'Copy quote',
      'bar.clear': 'Clear',
      'bar.remove': 'Remove this annotation',
      'bar.goto': 'Jump to this annotation',
      'bar.copied': 'Quote copied',
      'bar.failed': 'Could not insert',
      'bar.noQuestion': '(no question)',
      'quote.intro': 'These are the passages I annotated in this conversation. Please answer the question attached to each one.',
      'quote.item': '[{index}] turn {turn}',
      'quote.passage': 'Passage:',
      'quote.question': 'My question:',
      'quote.closing': 'Answer them in the numbered order above.'
    };

    /* The highlight rule is the one place literal colour is deliberate:
       `::highlight()` resolves a restricted property set where custom-property
       inheritance is unreliable, so a translucent amber readable on both light
       and dark surfaces replaces the theme tokens the rest of the UI uses.
       Every other surface below follows the --dsw-alias-* tokens. */
    const CSS = `
::highlight(dsm-mark){background-color:rgba(255,193,7,.34);text-decoration:underline;text-decoration-color:rgba(255,152,0,.95);text-decoration-thickness:2px;text-underline-offset:2px}
body[data-ds-dark-theme] ::highlight(dsm-mark){background-color:rgba(255,193,7,.24);text-decoration-color:rgba(255,193,7,.95)}
::highlight(dsm-pending){background-color:rgba(47,109,246,.28);text-decoration:underline;text-decoration-color:rgba(47,109,246,.95);text-decoration-thickness:2px;text-underline-offset:2px}
body[data-ds-dark-theme] ::highlight(dsm-pending){background-color:rgba(47,109,246,.38);text-decoration-color:rgba(120,170,255,.95)}
.dsm-toolbar{position:fixed;z-index:60;display:flex;align-items:center;gap:6px;padding:4px 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.dsm-toolbarEditor{display:block;width:360px;max-width:calc(100vw - 16px);padding:8px}
.dsm-bar{display:flex;align-items:stretch;gap:8px;flex-wrap:wrap;box-sizing:border-box;width:100%;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%}
.dsm-label{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dsm-chips{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.dsm-chip{display:inline-flex;align-items:center;gap:2px;height:24px;padding:0 4px 0 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;line-height:16px;white-space:nowrap;cursor:pointer}
.dsm-chip:hover{border-color:var(--dsw-alias-brand-primary)}
.dsm-chipText{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-chipX{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:none;border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:1;cursor:pointer}
.dsm-chipX:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsm-spacer{flex:1 1 auto}
.dsm-btn{height:24px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}
.dsm-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsm-btn[data-primary]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.dsm-btn[data-accent]{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-brand-primary);border-color:transparent}
.dsm-btn:disabled{cursor:default;opacity:.45}
.dsm-note{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dsm-editor{display:flex;flex-direction:column;gap:8px;width:100%}
.dsm-input{box-sizing:border-box;width:100%;min-height:44px;max-height:180px;padding:9px 11px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;resize:none;overflow-y:auto;field-sizing:content}
.dsm-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsm-editorHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
`;

    /* ------------------------------------------------------------------ *
     * Anchors: turn a DOM selection into a relocatable text-quote anchor
     * ------------------------------------------------------------------ */

    /** Walk up from a node to the chat row that contains it. */
    function rowOf(node) {
      if (node === null || node === undefined) return null;
      const element = node.nodeType === 1 ? node : node.parentElement;
      if (element === null || element === undefined) return null;
      return element.closest(ROW_SELECTOR);
    }

    /**
     * Character offsets of a range inside one row.
     *
     * `Range.toString()` concatenates the text nodes in document order, which is
     * exactly how offsets are re-resolved later, so both directions agree even
     * when a selection spans inline markup.
     * @param row - the containing chat row.
     * @param range - live selection range inside `row`.
     * @returns character offsets, or null when the range cannot be measured.
     */
    function offsetsIn(row, range) {
      const probe = document.createRange();
      try {
        probe.selectNodeContents(row);
        probe.setEnd(range.startContainer, range.startOffset);
        const start = probe.toString().length;
        probe.setEnd(range.endContainer, range.endOffset);
        const end = probe.toString().length;
        if (end <= start) return null;
        return { start, end };
      } catch {
        return null;
      }
    }

    /**
     * Resolve character offsets back to a DOM range.
     * @param row - the chat row that owns the anchor.
     * @param start - first character offset.
     * @param end - one past the last character offset.
     * @returns the range, or null when the row no longer holds those offsets.
     */
    function rangeAt(row, start, end) {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let total = 0;
      let opened = false;
      let node = walker.nextNode();
      while (node !== null) {
        const length = node.nodeValue === null ? 0 : node.nodeValue.length;
        const next = total + length;
        if (!opened && start >= total && start <= next) {
          range.setStart(node, Math.min(start - total, length));
          opened = true;
        }
        if (opened && end >= total && end <= next) {
          range.setEnd(node, Math.min(end - total, length));
          return range;
        }
        total = next;
        node = walker.nextNode();
      }
      return null;
    }

    /** The row that currently carries one anchor's key, if it is rendered. */
    function rowFor(anchor) {
      const rows = document.querySelectorAll(ROW_SELECTOR);
      for (const row of rows) {
        if (row.getAttribute(ROW_KEY_ATTR) === anchor.rowKey) return row;
      }
      return null;
    }

    /**
     * Re-locate an anchor in the live DOM.
     *
     * Stored offsets are tried first because they are exact. When the row's text
     * changed upstream — a collapsed group expanded, older content loaded — the
     * quote is searched with its stored neighbours first and on its own second,
     * so an annotation survives ordinary transcript churn.
     * @param anchor - stored annotation anchor.
     * @returns the range, or null when the passage is not rendered.
     */
    function locate(anchor) {
      const row = rowFor(anchor);
      if (row === null) return null;
      const text = row.textContent === null ? '' : row.textContent;
      let start = anchor.start;
      let end = anchor.end;
      if (text.slice(start, end) !== anchor.quote) {
        const framed = `${anchor.prefix}${anchor.quote}${anchor.suffix}`;
        let found = anchor.prefix === '' ? -1 : text.indexOf(framed);
        if (found >= 0) {
          start = found + anchor.prefix.length;
        } else {
          found = text.indexOf(anchor.quote);
          if (found < 0) return null;
          start = found;
        }
        end = start + anchor.quote.length;
      }
      return rangeAt(row, start, end);
    }

    /* ------------------------------------------------------------------ *
     * Durable per-Session annotation store
     * ------------------------------------------------------------------ */

    const stores = new Map();

    function readStored(sessionId) {
      try {
        const raw = window.localStorage.getItem(STORAGE_PREFIX + sessionId);
        if (raw === null) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item) => (
          item !== null
          && typeof item === 'object'
          && typeof item.id === 'string'
          && typeof item.rowKey === 'string'
          && typeof item.quote === 'string'
        ));
      } catch {
        return [];
      }
    }

    function writeStored(sessionId, items) {
      try {
        const key = STORAGE_PREFIX + sessionId;
        if (items.length === 0) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, JSON.stringify(items));
      } catch {
        /* storage unavailable: annotations stay in memory */
      }
    }

    function createStore(sessionId) {
      let items = readStored(sessionId);
      let state = { items };
      const listeners = new Set();
      const commit = (next) => {
        items = next.slice();
        state = { items };
        writeStored(sessionId, items);
        for (const listener of [...listeners]) listener();
      };
      return {
        getState: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        add(item) {
          commit([...items, item]);
        },
        remove(id) {
          commit(items.filter((current) => current.id !== id));
        },
        clear() {
          commit([]);
        }
      };
    }

    function storeFor(sessionId) {
      let store = stores.get(sessionId);
      if (store === undefined) {
        store = createStore(sessionId);
        stores.set(sessionId, store);
      }
      return store;
    }

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.getState, store.getState);
    }

    /** Hook-shaped stand-in, so an absent standard prop cannot change call order. */
    function useAbsentSnapshot(_selector, _equal) {
      return undefined;
    }

    /* ------------------------------------------------------------------ *
     * Highlight painting
     * ------------------------------------------------------------------ */

    /**
     * Repaint the Custom Highlight for one Session's annotations.
     *
     * The registry is global to the document, so one owner repaints all of them;
     * an annotation whose row is outside the virtual window contributes no range
     * and is picked up again as soon as that row renders.
     * @param items - annotations to paint.
     */
    function paintHighlights(items) {
      const registry = typeof CSS === 'undefined' ? undefined : CSS.highlights;
      if (registry === undefined || typeof Highlight !== 'function') return;
      const ranges = [];
      for (const item of items) {
        const range = locate(item);
        if (range !== null) ranges.push(range);
      }
      if (ranges.length === 0) {
        registry.delete(HIGHLIGHT_NAME);
        return;
      }
      registry.set(HIGHLIGHT_NAME, new Highlight(...ranges));
    }

    /**
     * Paint the passage the reader is currently annotating.
     *
     * Focusing the question field collapses the document selection, which is
     * what made the blue highlight vanish the instant the bubble appeared. The
     * passage is therefore re-painted as a Highlight range, so it stays visibly
     * marked while the reader types. It uses its own name so it can be cleared
     * without disturbing the saved annotations.
     * @param anchor - the pending anchor, or null to clear.
     */
    function paintPending(anchor) {
      const registry = typeof CSS === 'undefined' ? undefined : CSS.highlights;
      if (registry === undefined || typeof Highlight !== 'function') return;
      if (anchor === null) {
        registry.delete(PENDING_HIGHLIGHT);
        return;
      }
      const range = locate(anchor);
      if (range === null) {
        registry.delete(PENDING_HIGHLIGHT);
        return;
      }
      registry.set(PENDING_HIGHLIGHT, new Highlight(range));
    }

    function clearHighlights() {
      const registry = typeof CSS === 'undefined' ? undefined : CSS.highlights;
      if (registry !== undefined) {
        registry.delete(HIGHLIGHT_NAME);
        registry.delete(PENDING_HIGHLIGHT);
      }
    }

    /* ------------------------------------------------------------------ *
     * Quote construction
     * ------------------------------------------------------------------ */

    function clip(text, budget) {
      if (typeof text !== 'string') return '';
      return text.length <= budget ? text : `${text.slice(0, budget - 1)}…`;
    }

    function buildQuote(items, t) {
      const lines = [t('quote.intro'), ''];
      items.forEach((item, position) => {
        const turn = typeof item.turn === 'number' ? String(item.turn) : '?';
        const passage = clip(item.quote.trim(), QUOTE_BUDGET).replace(/\n/g, '\n> ');
        const question = typeof item.question === 'string' ? item.question.trim() : '';
        lines.push(t('quote.item', { index: String(position + 1), turn }));
        lines.push(`> ${passage}`);
        lines.push(`${t('quote.question')}${question === '' ? t('bar.noQuestion') : question}`);
        lines.push('');
      });
      lines.push(t('quote.closing'));
      return lines.join('\n');
    }

    /* ------------------------------------------------------------------ *
     * Icons
     * ------------------------------------------------------------------ */

    function MarkGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 13,
        height: 13,
        'aria-hidden': true,
        focusable: 'false'
      }, h('path', {
        d: 'M3.2 2.6h9.6v10.9l-4.8-3-4.8 3z',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinejoin: 'round'
      }));
    }

    /** Bubble geometry, in viewport coordinates. */
    const BUBBLE_OFFER = 190;
    const BUBBLE_EDITOR = 360;
    /** Measured height of the compact bubble (field + hint), for flip logic. */
    const BUBBLE_ESTIMATE_HEIGHT = 96;

    /**
     * Where the bubble wants to be, in viewport coordinates.
     * @param rect - the selection's bounding box.
     * @param width - bubble width for the current shape.
     * @returns left and top; `top` may be negative when it must sit below.
     */
    function placementOf(rect, width) {
      const span = width === undefined ? BUBBLE_OFFER : width;
      const maxLeft = Math.max(8, window.innerWidth - span - 8);
      const left = Math.min(Math.max(8, rect.left + rect.width / 2 - span / 2), maxLeft);
      // Above the selection by default; below when the top would leave no room.
      const above = rect.top - 8;
      const fitsAbove = above > BUBBLE_ESTIMATE_HEIGHT + 16;
      return { left, top: fitsAbove ? undefined : rect.top + rect.height + 8, above };
    }

    /* ------------------------------------------------------------------ *
     * Components
     * ------------------------------------------------------------------ */

    /**
     * Put the composer caret at the end and give it focus.
     *
     * The composer is a Lexical editor. Replacing its document through
     * `setDraft` leaves the editor without a selection, and an editor with no
     * selection has nothing for Enter to submit — the key press appears to do
     * nothing at all. Restoring the caret also leaves the reader ready to keep
     * typing where the quote block ends.
     */
    function restoreComposerCaret() {
      try {
        const editor = document.querySelector('[data-composer-card] [contenteditable="true"]');
        if (editor === null) return;
        editor.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      } catch {
        /* focus is best effort; the draft is already correct */
      }
    }

    /**
     * The bubble anchored to the selection, already in its question form.
     *
     * Marking a passage and asking about it are one motion, so the textarea
     * appears as soon as the selection settles and takes focus. The bubble
     * measures its own containing block and corrects for scroll-container
     * offsets, so it stays next to the text it belongs to.
     */
    const SelectionBubble = React.forwardRef(function SelectionBubble(props, ref) {
      const { pending, question, inputRef, onChange, onSave, onSaveOnly, onCancel, t } = props;
      const [drift, setDrift] = React.useState({ dx: 0, dy: 0 });
      const localRef = React.useRef(null);

      // Combine the caller's ref with the one used for measurement.
      const attach = React.useCallback((node) => {
        localRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref !== null && ref !== undefined) ref.current = node;
      }, [ref]);

      const place = placementOf(pending.rect, BUBBLE_EDITOR);

      React.useLayoutEffect(() => {
        const element = localRef.current;
        if (element === null) return;
        const wanted = {
          left: place.left,
          top: place.top === undefined ? pending.rect.top - BUBBLE_ESTIMATE_HEIGHT - 8 : place.top
        };
        element.__dsmAnchor = wanted;
        const box = element.getBoundingClientRect();
        if (box.width === 0) return;
        const dx = wanted.left - box.left;
        const dy = wanted.top - box.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) setDrift({ dx, dy });
      }, [pending.rect.left, pending.rect.top, pending.rect.width, pending.rect.height, place.left, place.top]);

      const wantedTop = place.top === undefined
        ? Math.max(8, pending.rect.top - BUBBLE_ESTIMATE_HEIGHT - 8)
        : place.top;

      return h('div', {
        ref: attach,
        className: 'dsm-toolbar dsm-toolbarEditor',
        style: {
          left: `${place.left + drift.dx}px`,
          top: `${wantedTop + drift.dy}px`
        },
        // Keep the selection alive while the pointer travels to the bubble, and
        // stop the document-level "clicked away" handler from treating a click
        // inside the bubble as leaving it.
        onMouseDown: (event) => {
          event.preventDefault();
          event.stopPropagation();
        },
        onClick: (event) => {
          event.stopPropagation();
        }
      }, h(MarkEditor, { pending, question, inputRef, onChange, onSave, onSaveOnly, onCancel, t }));
    });

    /**
     * The inline question form.
     *
     * The passage is already highlighted in the transcript behind this bubble,
     * so repeating it here would only be a second box saying what the selection
     * already says. The bubble therefore holds the question field alone.
     *
     * Keys: `Enter` annotates and sends in one step, `Shift+Enter` annotates
     * without sending (to collect more marks first), `Escape` discards.
     */
    function MarkEditor(props) {
      const { question, inputRef, onChange, onSave, onSaveOnly, onCancel, t } = props;
      return h('div', { className: 'dsm-editor' },
        h('textarea', {
          ref: inputRef,
          className: 'dsm-input',
          value: question,
          placeholder: t('editor.placeholder'),
          'aria-label': t('editor.question'),
          onChange: (event) => onChange(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              // A newline is never wanted in a one-line question.
              event.preventDefault();
              if (event.shiftKey) onSaveOnly();
              else onSave();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          }
        }),
        h('div', { className: 'dsm-editorHint' }, t('editor.hint')));
    }

    /**
     * Owns selection capture, the anchored question bubble, the annotation
     * list, and the highlight repaint for one Session.
     */
    function SessionMarks(props) {
      const sessionId = props.sessionId;
      const store = props.marks;
      const t = props.t;
      const state = useStore(store);
      const items = state.items;

      const useInput = typeof props.useInput === 'function' ? props.useInput : useAbsentSnapshot;
      const draft = useInput((input) => (input === undefined || input === null ? '' : input.draft));

      /** A captured selection; the bubble opens on it immediately. */
      const [pending, setPending] = React.useState(null);
      /** A transient explanation shown in the bar. */
      const [notice, setNotice] = React.useState(null);
      /** The draft question for the pending selection. */
      const [question, setQuestion] = React.useState('');
      const timerRef = React.useRef(null);
      const inputRef = React.useRef(null);
      /** True while the bubble owns the selection, so capture must stand down. */
      const pendingRef = React.useRef(false);
      pendingRef.current = pending !== null;

      const flash = React.useCallback((message) => {
        setNotice(message);
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          setNotice(null);
        }, 2400);
      }, []);

      React.useEffect(() => () => {
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      }, []);

      /* --- selection capture ------------------------------------------- */

      React.useEffect(() => {
        let timer = null;
        const read = () => {
          timer = null;
          // While the bubble owns a selection, taking focus into its textarea
          // collapses the document selection; that is not the reader leaving.
          if (pendingRef.current) return;
          const selection = window.getSelection();
          if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return;
          const range = selection.getRangeAt(0);
          const row = rowOf(range.startContainer);
          const otherRow = rowOf(range.endContainer);
          if (row === null) return;
          if (row !== otherRow) {
            // A cross-row selection has no single anchor; say so instead of
            // silently doing nothing.
            flash(t('pending.multi'));
            return;
          }
          const offsets = offsetsIn(row, range);
          if (offsets === null) return;
          const rowText = row.textContent === null ? '' : row.textContent;
          const quote = rowText.slice(offsets.start, offsets.end);
          if (quote.trim() === '') return;
          const box = range.getBoundingClientRect();
          const turn = Number(row.getAttribute('data-chat-turn'));
          setPending({
            anchor: {
              id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
              sessionId,
              rowKey: row.getAttribute(ROW_KEY_ATTR) ?? '',
              start: offsets.start,
              end: offsets.end,
              quote,
              prefix: rowText.slice(Math.max(0, offsets.start - CONTEXT_CHARS), offsets.start),
              suffix: rowText.slice(offsets.end, offsets.end + CONTEXT_CHARS),
              turn: Number.isFinite(turn) ? turn : undefined
            },
            rect: { left: box.left, top: box.top, width: box.width, height: box.height }
          });
          setQuestion('');
        };
        // Reading on `selectionchange` would open the bubble mid-drag, before
        // the passage is even selected — and focusing the textarea at that
        // moment steals the gesture and breaks the selection. So capture only
        // once a gesture ends, deferred a turn so a double-click's word
        // selection has been applied by the browser first.
        const defer = () => {
          if (timer !== null) window.clearTimeout(timer);
          timer = window.setTimeout(read, 0);
        };
        const onKeyUp = (event) => {
          // Keyboard selection (Shift+arrows, Ctrl/Cmd+A) produces no pointer
          // event, so those keys arm the same deferred capture.
          if (event.shiftKey || event.key === 'a' || event.key === 'A') defer();
        };
        document.addEventListener('pointerup', defer);
        document.addEventListener('dblclick', defer);
        document.addEventListener('keyup', onKeyUp);
        return () => {
          document.removeEventListener('pointerup', defer);
          document.removeEventListener('dblclick', defer);
          document.removeEventListener('keyup', onKeyUp);
          if (timer !== null) window.clearTimeout(timer);
        };
      }, [flash, sessionId, t]);

      /* --- keep the pending passage visibly marked ---------------------- */

      // Focusing the question field collapses the browser selection, so the
      // blue native highlight disappears exactly when the bubble appears. The
      // pending passage is re-painted as a Highlight range instead, which
      // survives the focus move and keeps the reader's anchor visible.
      React.useEffect(() => {
        paintPending(pending === null ? null : pending.anchor);
        if (pending === null) return undefined;
        let frame = null;
        const repaint = () => {
          frame = null;
          paintPending(pending.anchor);
        };
        const schedule = () => {
          if (frame !== null) return;
          frame = window.requestAnimationFrame(repaint);
        };
        // Rows re-render and scroll; re-resolve the range when the DOM moves.
        const observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        window.addEventListener('scroll', schedule, true);
        return () => {
          observer.disconnect();
          window.removeEventListener('scroll', schedule, true);
          if (frame !== null) window.cancelAnimationFrame(frame);
        };
      }, [pending]);

      /* --- highlight repaint ------------------------------------------- */

      React.useEffect(() => {
        let frame = null;
        const repaint = () => {
          frame = null;
          paintHighlights(items);
        };
        const schedule = () => {
          if (frame !== null) return;
          frame = window.requestAnimationFrame(repaint);
        };
        schedule();
        // Rows are virtualized and re-render as a Turn advances, so offsets are
        // re-resolved whenever the transcript DOM changes.
        const observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        window.addEventListener('scroll', schedule, true);
        return () => {
          observer.disconnect();
          window.removeEventListener('scroll', schedule, true);
          if (frame !== null) window.cancelAnimationFrame(frame);
          clearHighlights();
        };
      }, [items]);

      /* --- focus -------------------------------------------------------- */

      // The textarea takes focus the moment a selection is captured, so the
      // reader types immediately instead of clicking twice.
      React.useEffect(() => {
        if (pending === null) return;
        const element = inputRef.current;
        if (element !== null) element.focus();
      }, [pending]);

      /* --- click away cancels ------------------------------------------ */

      // Declared before the effect that uses it: `const` bindings are in the
      // temporal dead zone until initialised, so a later ref would throw on the
      // first render that reaches the listener setup.
      const cancelRef = React.useRef(() => {});

      React.useEffect(() => {
        if (pending === null) return undefined;
        // Cancel on a pointer press anywhere outside the bubble. The bubble
        // stops propagation on its own presses, so this only fires for real
        // "clicked elsewhere" gestures — no cancel button needed.
        const onPointerDown = () => {
          cancelRef.current();
        };
        // `capture` is required: the chat surface stops propagation on many of
        // its own rows, which would otherwise swallow this.
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
        };
      }, [pending]);

      /* --- verbs -------------------------------------------------------- */

      const cancel = React.useCallback(() => {
        setPending(null);
        setQuestion('');
        const selection = window.getSelection();
        if (selection !== null) selection.removeAllRanges();
      }, []);

      // The pointer handler above needs the latest `cancel` without
      // re-subscribing on every render.
      cancelRef.current = cancel;

      /**
       * Commit the pending question and immediately send everything.
       *
       * `Enter` in the bubble is the whole gesture: annotate, ask, send. The
       * draft mirror runs on the effect that follows this state change, so the
       * submit waits for the draft to actually contain the new block instead of
       * guessing a delay — sending before the mirror lands would post the old
       * text (missing this annotation).
       * @param sendNow - true for Enter, false to only record the annotation.
       */
      const commit = React.useCallback((sendNow) => {
        if (pending === null) return;
        store.add({ ...pending.anchor, question: question.trim(), createdAt: Date.now() });
        setPending(null);
        setQuestion('');
        const selection = window.getSelection();
        if (selection !== null) selection.removeAllRanges();
        if (!sendNow) {
          window.setTimeout(restoreComposerCaret, 0);
          return;
        }
        // Poll a few frames for the mirror to publish, then submit. The counter
        // bounds the wait so a failed mirror never leaves the reader hung.
        let attempts = 0;
        const trySend = () => {
          attempts += 1;
          const actions = props.inputActions;
          const current = typeof draft === 'string' ? draft : '';
          const ready = actions !== undefined
            && actions !== null
            && typeof actions.submit === 'function'
            && current.trim() !== '';
          if (ready) {
            restoreComposerCaret();
            try {
              actions.submit();
            } catch {
              /* the reader can still press Enter in the composer */
            }
            return;
          }
          if (attempts >= 12) {
            // Give up on auto-send, but never swallow the annotation: the block
            // is mirrored and the reader's own Enter still works.
            restoreComposerCaret();
            return;
          }
          window.requestAnimationFrame(trySend);
        };
        window.requestAnimationFrame(trySend);
      }, [draft, pending, props.inputActions, question, store]);

      const save = React.useCallback(() => {
        commit(true);
      }, [commit]);

      const saveOnly = React.useCallback(() => {
        commit(false);
      }, [commit]);

      /* --- keep the composer draft in sync with the annotations ---------- */

      /**
       * The block this plugin currently owns inside the draft, or null.
       *
       * Annotations are mirrored into the composer so the ordinary Send/Enter
       * action is armed without a second click. Ownership is tracked by the
       * exact string written, which is what makes removal safe: the plugin only
       * ever rewrites or strips text it put there itself.
       */
      const injectedRef = React.useRef(null);
      /** Set while the plugin writes, so its own draft echo is not "a send". */
      const writingRef = React.useRef(false);
      /** Content signature of the annotations the draft currently mirrors. */
      const signatureRef = React.useRef('');

      const writeDraft = React.useCallback((next) => {
        const actions = props.inputActions;
        if (actions === undefined || actions === null) return false;
        writingRef.current = true;
        try {
          actions.setDraft(next);
          return true;
        } catch {
          return false;
        } finally {
          // The store publishes the edit asynchronously; release the guard on
          // the next task so the echo lands while it is still held.
          window.setTimeout(() => {
            writingRef.current = false;
          }, 0);
          // `setDraft` replaces the whole Lexical document, which drops its
          // selection. With no selection the composer's Enter/Send has no
          // target and silently does nothing, so the caret is put back at the
          // end — which is also where the reader wants it after saving a note.
          restoreComposerCaret();
        }
      }, [props.inputActions]);

      // Mirror the annotations into the draft: adding, editing, or removing one
      // rewrites the owned block in place instead of requiring a manual quote.
      //
      // The annotations, not the draft, are the trigger. Rewriting merely
      // because the draft changed would fight the reader (re-adding a block they
      // deleted) and would also race the send that empties the draft.
      React.useEffect(() => {
        const current = typeof draft === 'string' ? draft : '';
        const owned = injectedRef.current;
        const signature = items
          .map((item) => `${item.id}\u0000${item.quote}\u0000${item.question}`)
          .join('\u0001');
        const annotationsChanged = signature !== signatureRef.current;
        signatureRef.current = signature;

        if (items.length === 0) {
          // Everything was cleared: drop only the block this plugin wrote.
          if (owned !== null && current.includes(owned)) {
            writeDraft(current.replace(owned, '').replace(/\s+$/, ''));
          }
          injectedRef.current = null;
          return;
        }

        const block = buildQuote(items, t);

        if (owned !== null && current.includes(owned)) {
          // Rewrite in place, preserving anything the reader typed around it.
          if (block !== owned && writeDraft(current.replace(owned, block))) {
            injectedRef.current = block;
          }
          return;
        }

        if (!annotationsChanged && owned !== null) {
          // The block is no longer in the draft although the annotations did not
          // change: the reader deleted it, or the commit consumed it. Either way
          // re-adding it would override them, so ownership lapses here.
          injectedRef.current = null;
          return;
        }

        // First annotation, or the annotations changed while unowned: append.
        const lead = current.trim() === '' ? '' : '\n\n';
        const next = `${current}${lead}${block}`;
        if (writeDraft(next)) injectedRef.current = block;
      }, [draft, items, t, writeDraft]);

      // A send empties the committed draft, so the annotations have served their
      // purpose and are dropped with it. The guard keeps the plugin's own draft
      // writes from being mistaken for a send.
      const hadDraftRef = React.useRef(false);
      React.useEffect(() => {
        const current = typeof draft === 'string' ? draft : '';
        const wasFull = hadDraftRef.current;
        hadDraftRef.current = current.trim() !== '';
        if (writingRef.current) return;
        if (!wasFull || current.trim() !== '') return;
        if (items.length === 0) return;
        store.clear();
        injectedRef.current = null;
      }, [draft, items, store]);

      const copy = React.useCallback(() => {
        const text = buildQuote(items, t);
        try {
          const result = window.navigator.clipboard.writeText(text);
          if (result !== undefined && typeof result.then === 'function') {
            result.then(() => flash(t('bar.copied')), () => flash(t('bar.failed')));
            return;
          }
          flash(t('bar.copied'));
        } catch {
          flash(t('bar.failed'));
        }
      }, [flash, items, t]);

      const goTo = React.useCallback((item) => {
        const range = locate(item);
        if (range === null) return;
        const node = range.startContainer;
        const element = node.nodeType === 1 ? node : node.parentElement;
        if (element !== null && element !== undefined) {
          element.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }, []);

      /* --- render ------------------------------------------------------- */

      // A captured selection opens the question bubble right next to the text.
      // Nothing is mirrored below, so there is one target for the eye.
      const bubble = pending !== null ? h(SelectionBubble, {
        pending,
        question,
        inputRef,
        onChange: setQuestion,
        onSave: save,
        onSaveOnly: saveOnly,
        onCancel: cancel,
        t
      }) : null;

      // The bar below carries the collected annotations only; it stays out of
      // the way while a selection is being handled.
      const bar = items.length === 0 || pending !== null ? null : h('div', { className: 'dsm-bar' },
        h('div', { className: 'dsm-row' },
          h('span', { className: 'dsm-label' },
            h(MarkGlyph, null),
            h('span', null, t('bar.count', { count: String(items.length) }))),
          h('span', { className: 'dsm-chips' }, items.map((item, index) => h('span', {
            className: 'dsm-chip',
            key: item.id,
            title: `${item.quote}\n\n${t('bar.goto')}`,
            onClick: () => goTo(item)
          },
          h('span', { className: 'dsm-chipText' }, `[${index + 1}] ${clip(item.quote.replace(/\s+/g, ' ').trim(), 40)}`),
          h('button', {
            type: 'button',
            className: 'dsm-chipX',
            title: t('bar.remove'),
            'aria-label': t('bar.remove'),
            onClick: (event) => {
              event.stopPropagation();
              store.remove(item.id);
            }
          }, '×')))),
          notice === null ? null : h('span', { className: 'dsm-note' }, notice),
          h('span', { className: 'dsm-spacer' }),
          h('button', { type: 'button', className: 'dsm-btn', onClick: copy }, t('bar.copy')),
          h('button', {
            type: 'button',
            className: 'dsm-btn',
            onClick: () => {
              store.clear();
            }
          }, t('bar.clear'))));

      if (bubble === null && bar === null) return null;
      return h(React.Fragment, null, bubble, bar);
    }

    /* ------------------------------------------------------------------ *
     * Plugin body
     * ------------------------------------------------------------------ */

    /** Required services: the slot registry and the copy. */
    const inject = ['slots', 'locale'];

    /**
     * Mount the annotation surface.
     * @param ctx - Client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-marks: dictionaries');
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-session-marks';
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, 'session-marks: stylesheet');
      ctx.effect(() => () => {
        stores.clear();
        clearHighlights();
      }, 'session-marks: stores');

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'session-marks',
        order: 30,
        locale: NS,
        inject: (sessionId) => ({ marks: storeFor(sessionId) })
      }, SessionMarks));
    }

    /**
     * Test seam: the internal pieces, so an offline harness can render them
     * without a browser. The slot registry only ever exposes `apply`, and this
     * export changes no runtime behaviour.
     */
    const __internals = Object.freeze({
      SelectionBubble,
      MarkEditor,
      MarkGlyph,
      placementOf,
      buildQuote,
      clip
    });

    return { inject, apply, __internals };
  }
});
