/**
 * Render the plugin's real React tree on the server and fail on any invalid
 * element type.
 *
 * `#130` ("element type is invalid") is exactly what a `h(Component())` typo
 * produces, and it took a human reading the browser console to find it. This
 * harness loads `client.js` unmodified, captures the plugin's slot registration,
 * and renders the component with representative props into ReactDOMServer, so
 * the same mistake fails here first.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const REACT_PATH = process.argv[2];
const PLUGIN = process.argv[3];
const require = createRequire(path.join(REACT_PATH, 'noop.js'));

const React = require('react');
const ReactDOMServer = require('react-dom/server');

let failures = 0;
function ok(name) {
  console.log('ok  ', name);
}
function fail(name, error) {
  failures += 1;
  console.log('FAIL', name, '\n     ', String(error && error.message ? error.message : error).split('\n')[0]);
}

/* --- a minimal browser stand-in -------------------------------------- */

const head = [];
globalThis.window = globalThis;
globalThis.document = {
  head: { appendChild: (node) => head.push(node) },
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  createRange: () => ({
    setStart() {}, setEnd() {}, selectNodeContents() {}, toString: () => ''
  }),
  createTreeWalker: () => ({ nextNode: () => null })
};
globalThis.NodeFilter = { SHOW_TEXT: 4 };
// `navigator` is an accessor on modern Node, so it is redefined, not assigned.
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true
});
globalThis.localStorage = {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, value) { this.store.set(key, String(value)); },
  removeItem(key) { this.store.delete(key); }
};
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
globalThis.cancelAnimationFrame = () => {};
globalThis.CSS = {};
// Viewport metrics the placement math reads; Node has no window size.
globalThis.innerWidth = 1400;
globalThis.innerHeight = 900;
globalThis.clipboardData = undefined;

/* --- capture the module the loader registers ------------------------- */

let registered = null;
globalThis.window.__ModuleLoader__ = {
  load(spec) {
    registered = spec;
  }
};

const source = fs.readFileSync(PLUGIN, 'utf8');
// The module is plain browser JS registering itself on the loader; evaluate it
// with a CommonJS-shaped require so its `require('react')` resolves for real.
const moduleShim = { exports: {} };
const factoryRequire = (id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require: ${id}`);
};
// eslint-disable-next-line no-new-func
new Function('window', 'require', 'module', 'exports', source)(
  globalThis.window,
  factoryRequire,
  moduleShim,
  moduleShim.exports
);

if (registered === null) {
  console.log('FAIL module did not register on window.__ModuleLoader__');
  process.exit(1);
}
ok('module registers on the module loader');

const plugin = registered.factory(factoryRequire);
if (typeof plugin.apply !== 'function') {
  console.log('FAIL plugin exposes no apply()');
  process.exit(1);
}
ok('plugin exposes apply()');

/* --- run apply() against a capture-only slot registry ---------------- */

const captures = [];
const ctx = {
  effect(callback, label) {
    const dispose = callback();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  locale: {
    register: () => () => {},
    bind: () => (_key, _params) => String(_key)
  },
  slots: {
    inject(_slot, callback) {
      callback();
      return () => {};
    },
    register(options, Component) {
      captures.push({ options, Component });
      return () => {};
    }
  },
  get: () => undefined
};

try {
  plugin.apply(ctx);
  ok('apply() completes');
} catch (error) {
  fail('apply() completes', error);
}

if (captures.length !== 1) {
  console.log(`FAIL expected exactly one slot registration, got ${captures.length}`);
  process.exit(1);
}
const { options, Component } = captures[0];
ok(`registers slot "${options.name}" id "${options.id}" with order ${options.order}`);

if (typeof Component !== 'function') {
  console.log('FAIL registered component is not a function');
  process.exit(1);
}

/* --- render the component in the states the slot can reach ----------- */

function translator(key, params) {
  return params === undefined ? key : `${key}${JSON.stringify(params)}`;
}

const marks = {
  getState: () => ({ items: [] }),
  subscribe: () => () => {},
  add() {},
  remove() {},
  clear() {}
};

const baseProps = {
  marks,
  t: translator,
  sessionId: 'session-test',
  useInput: (selector) => selector(''),
  inputActions: {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
    insertText: () => true,
    setDraft: () => {}
  }
};

function render(name, props) {
  try {
    const html = ReactDOMServer.renderToStaticMarkup(React.createElement(Component, props));
    ok(`${name} renders (${html.length} bytes)`);
    return html;
  } catch (error) {
    fail(`${name} renders`, error);
    return '';
  }
}

render('empty state', baseProps);

/* Populated state, exercising the annotation chips and every button. */
const itemsProps = {
  ...baseProps,
  marks: {
    ...marks,
    getState: () => ({
      items: [
        {
          id: 'm-1',
          rowKey: 'k1',
          start: 3,
          end: 20,
          quote: 'synchronized (this) 会阻塞',
          prefix: '',
          suffix: '',
          question: '为什么不用乐观锁？',
          turn: 3,
          createdAt: 1
        },
        {
          id: 'm-2',
          rowKey: 'k2',
          start: 0,
          end: 8,
          quote: 'third retry',
          prefix: '',
          suffix: '',
          question: '',
          turn: 7,
          createdAt: 2
        }
      ]
    })
  }
};
const populated = render('annotated state', itemsProps);
if (populated.includes('dsm-bar') && populated.includes('dsm-chip')) {
  ok('annotated state renders the bar and chips');
} else {
  fail('annotated state renders the bar and chips', new Error('missing bar/chip markup'));
}

/* The editor subtree, which is where the invalid element type actually lived.
   It is internal, so it is driven by reaching into the module's evaluator: the
   plugin object does not export it, but the factory's closure created it. The
   only faithful way to reach it is a captured selection, so instead of faking
   module internals the pending path is asserted through the public markup
   contract below, and the source guard covers the element-type class of bug. */

/* --- static guard: no `h(Component())` anywhere ---------------------- */

{
  const source = fs.readFileSync(PLUGIN, 'utf8');
  // Any `h(` immediately followed by an identifier and `(` is a call used where
  // React wants a type. Lowercase tags take props (`h('div', {...})`), so they
  // never match. A call whose result is a STRING is not an element type at all:
  // `h(t('key'))` passes rendered copy as a child, which React accepts, so the
  // translator and other text producers are excluded rather than reported.
  const textProducers = new Set(['t', 'clip', 'String', 'JSON.stringify', 'buildQuote', 'formatMessageClock']);
  const bad = source.match(/h\(\s*([A-Za-z_$][\w$.]*)\s*\(/g) ?? [];
  const flagged = bad.filter((hit) => {
    const name = hit.replace(/^h\(\s*/, '').replace(/\s*\($/, '');
    return !textProducers.has(name);
  });
  if (flagged.length === 0) ok('no call-as-element-type in source');
  else fail('no call-as-element-type in source', new Error(JSON.stringify(flagged)));

  // React.Fragment must be referenced as a value, never called.
  const fragCall = /React\.Fragment\s*\(/.test(source);
  if (!fragCall) ok('React.Fragment is never invoked');
  else fail('React.Fragment is never invoked', new Error('found React.Fragment(...)'));
}

/* --- the selection bubble: one shape, opened by the selection itself -- */

{
  const internals = plugin.__internals;
  if (internals === undefined) {
    fail('plugin exposes test internals', new Error('__internals missing'));
  } else {
    const pending = {
      anchor: {
        id: 'm-pending',
        rowKey: 'k9',
        start: 10,
        end: 68,
        quote: 'synchronized (this) 会阻塞其他线程，因此高并发下需要改用无锁结构',
        prefix: '',
        suffix: '',
        turn: 3
      },
      rect: { left: 200, top: 400, width: 300, height: 20 }
    };
    const bubbleProps = {
      pending,
      question: '',
      inputRef: { current: null },
      onChange() {},
      onSave() {},
      onCancel() {},
      t: translator
    };

    const html = (() => {
      try {
        return ReactDOMServer.renderToStaticMarkup(React.createElement(internals.SelectionBubble, bubbleProps));
      } catch (error) {
        fail('selection bubble renders', error);
        return '';
      }
    })();

    // A selection must land straight in the question field.
    if (html.includes('<textarea') && html.includes('dsm-toolbarEditor')) {
      ok('selection opens the question field directly');
    } else {
      fail('selection opens the question field directly',
        new Error(`textarea=${html.includes('<textarea')} editorClass=${html.includes('dsm-toolbarEditor')}`));
    }

    // The passage is already highlighted in the transcript, so the bubble must
    // not repeat it: exactly one input, and no echoed copy of the selection.
    if (!html.includes('dsm-quote') && !html.includes('<blockquote')) {
      ok('bubble does not repeat the selected passage');
    } else {
      fail('bubble does not repeat the selected passage',
        new Error(`quote=${html.includes('dsm-quote')} blockquote=${html.includes('<blockquote')}`));
    }

    // "只有一个框": one focused control and nothing else that looks like a field.
    const textareas = (html.match(/<textarea/g) ?? []).length;
    const inputs = (html.match(/<input/g) ?? []).length;
    if (textareas === 1 && inputs === 0) ok('bubble contains exactly one input control');
    else fail('bubble contains exactly one input control', new Error(`textarea=${textareas} input=${inputs}`));

    // The quoted passage must not leak back in as text either.
    if (!html.includes(pending.anchor.quote)) {
      ok('bubble does not echo the passage text');
    } else {
      fail('bubble does not echo the passage text', new Error('selection text appears in the bubble'));
    }

    // The offer step is gone: no mark/cancel pair should remain.
    if (!html.includes('action.mark') && !html.includes('action.cancel')) {
      ok('no intermediate mark step in the bubble');
    } else {
      fail('no intermediate mark step in the bubble', new Error('found action.mark/action.cancel copy'));
    }

    // No save/cancel buttons: Enter commits and clicking away discards, so the
    // bubble must expose neither an action row nor those button labels.
    if (!html.includes('dsm-editorActions') && !html.includes('editor.save') && !html.includes('editor.cancel')) {
      ok('no save/cancel buttons in the bubble');
    } else {
      fail('no save/cancel buttons in the bubble',
        new Error(`actions=${html.includes('dsm-editorActions')} save=${html.includes('editor.save')} cancel=${html.includes('editor.cancel')}`));
    }

    // The keyboard contract must be visible while typing.
    if (html.includes('dsm-editorHint') && html.includes('editor.hint')) {
      ok('bubble shows the Enter/Esc/click-away hint');
    } else {
      fail('bubble shows the Enter/Esc/click-away hint', new Error('hint missing'));
    }

    // The bubble must not duplicate the collected-annotations bar.
    if (!html.includes('dsm-bar')) ok('bubble does not duplicate the annotations bar');
    else fail('bubble does not duplicate the annotations bar', new Error('found dsm-bar inside the bubble'));

    // Placement stays inside the viewport for an edge-of-window selection.
    const edge = internals.placementOf({ left: 5, top: 30, width: 10, height: 18 }, 400);
    if (edge.left >= 8 && edge.left <= 1400 - 400 - 8) ok('bubble placement clamps to the viewport');
    else fail('bubble placement clamps to the viewport', new Error(JSON.stringify(edge)));

    // A selection near the top must be placed below, not off-screen above.
    const low = internals.placementOf({ left: 200, top: 30, width: 100, height: 18 }, 400);
    if (low.top !== undefined && low.top > 30) ok('bubble flips below when there is no room above');
    else fail('bubble flips below when there is no room above', new Error(JSON.stringify(low)));

    // A roomy selection keeps the bubble above it.
    const high = internals.placementOf({ left: 200, top: 600, width: 100, height: 18 }, 400);
    if (high.top === undefined) ok('bubble sits above a selection with room');
    else fail('bubble sits above a selection with room', new Error(JSON.stringify(high)));
  }
}

/* --- selection gesture and dismissal wiring --------------------------- */

{
  const source = fs.readFileSync(PLUGIN, 'utf8');

  // The bubble must not open while a drag is still in progress. Reading on
  // `selectionchange` opened it mid-drag and stole the gesture, so that
  // listener must be gone and pointer-up must be the trigger.
  if (!/addEventListener\(\s*'selectionchange'/.test(source)) {
    ok('no selectionchange-driven capture (would fire mid-drag)');
  } else {
    fail('no selectionchange-driven capture (would fire mid-drag)', new Error("found addEventListener('selectionchange')"));
  }
  if (/addEventListener\(\s*'pointerup'/.test(source)) ok('capture arms on pointerup');
  else fail('capture arms on pointerup', new Error("missing addEventListener('pointerup')"));

  // Keyboard selections produce no pointer event.
  if (/addEventListener\(\s*'keyup'/.test(source)) ok('capture arms on keyup (keyboard selection)');
  else fail('capture arms on keyup (keyboard selection)', new Error("missing addEventListener('keyup')"));

  // Clicking away must cancel in the capture phase so rows that stop propagation
  // cannot swallow it.
  const hasAway = /addEventListener\(\s*'pointerdown'[^)]*true\s*\)/.test(source);
  if (hasAway) ok('clicking away cancels (capture-phase pointerdown)');
  else fail('clicking away cancels (capture-phase pointerdown)', new Error('missing capture-phase pointerdown'));

  // The cancel must be a CONTAINMENT TEST on the event target.
  //
  // A capture-phase listener on `document` runs before the bubble's own handler,
  // so `stopPropagation()` inside the bubble cannot protect a click on it: an
  // unconditional cancel closed the bubble the moment the reader clicked its own
  // textarea. The previous assertion here checked for `stopPropagation`, which
  // passed while the behaviour was broken — it is replaced by this one.
  const containment = /const current = bubbleRef\.current;[\s\S]{0,160}?current\.contains\(target\)[\s\S]{0,40}?return;/.test(source);
  if (containment) {
    ok('a press inside the bubble does not cancel it');
  } else {
    fail('a press inside the bubble does not cancel it',
      new Error('click-away handler does not test containment'));
  }

  // The containment test must read the ref at event time: the bubble mounts in
  // the same commit that arms the listener, so a ref captured earlier can be null.
  const readsAtEventTime = /const onPointerDown = \(event\) => \{[\s\S]{0,400}?bubbleRef\.current/.test(source);
  if (readsAtEventTime) ok('containment reads the live bubble ref');
  else fail('containment reads the live bubble ref', new Error('bubble ref captured too early'));

  // Enter sends in one step, Shift+Enter only records, and neither produces a
  // newline. The handler branches on the modifier INSIDE the Enter branch now,
  // so the assertion pins that shape rather than the old `&& !shiftKey` form.
  const enterSends = /event\.key === 'Enter'[\s\S]{0,200}?if \(event\.shiftKey\) onSaveOnly\(\);[\s\S]{0,80}?else onSave\(\);/.test(source);
  if (enterSends) ok('Enter sends, Shift+Enter saves only');
  else fail('Enter sends, Shift+Enter saves only', new Error('Enter no longer branches on shift'));

  // The send must go through the composer's own submit action, not a synthetic
  // key press or a direct draft write.
  if (/actions\.submit\(\)/.test(source)) ok('sending uses the composer submit action');
  else fail('sending uses the composer submit action', new Error('no actions.submit() call'));
}

/* --- draft mirroring and post-send cleanup ---------------------------- */

{
  const source = fs.readFileSync(PLUGIN, 'utf8');

  // These assertions must test the CODE, not the comments around it: a mutant
  // that only flips a condition still contains every doc string, so matching
  // prose would pass on a broken plugin. Each check below therefore pins an
  // actual decision the runtime makes.

  // The mirror is gated on a signature comparison; a truthy constant would let
  // any draft change re-append the block and fight the reader.
  if (/const annotationsChanged = signature !== signatureRef\.current;/.test(source)) {
    ok('draft mirror is driven by annotation changes, not draft changes');
  } else {
    fail('draft mirror is driven by annotation changes, not draft changes',
      new Error('signature comparison is not the gate'));
  }

  // Ownership must lapse through a real early return, not a dead branch.
  if (/if \(!annotationsChanged && owned !== null\) \{\s*\n\s*\/\/[^]*?injectedRef\.current = null;\s*\n\s*return;/.test(source)) {
    ok('plugin stops re-adding a block the reader deleted');
  } else {
    fail('plugin stops re-adding a block the reader deleted', new Error('no ownership-lapse branch'));
  }

  // The send must actually call store.clear() inside the send effect, and the
  // write guard must be a live condition rather than a disabled one.
  const sendEffect = source.slice(source.indexOf('// A send empties the committed draft'));
  const sendBody = sendEffect.slice(0, sendEffect.indexOf('}, [draft, items, store]);'));
  const clearsOnSend = /if \(!wasFull \|\| current\.trim\(\) !== ''\) return;/.test(sendBody)
    && /store\.clear\(\);/.test(sendBody)
    && /if \(writingRef\.current\) return;/.test(sendBody);
  if (clearsOnSend) ok('a send clears the annotations');
  else fail('a send clears the annotations', new Error('send effect does not clear under the right guards'));

  // The manual "quote into composer" step is gone: the draft already holds it.
  if (!source.includes("'bar.quote'") && !/onClick: quote/.test(source)) {
    ok('no manual quote-to-composer step remains');
  } else {
    fail('no manual quote-to-composer step remains', new Error('found a quote action'));
  }

  // The plugin's own writes must be excluded from send detection by a live
  // guard in the mirror path too.
  if (/writingRef\.current = true;/.test(source) && /if \(writingRef\.current\) return;/.test(source)) {
    ok('plugin writes are excluded from send detection');
  } else {
    fail('plugin writes are excluded from send detection', new Error('write guard missing or disabled'));
  }
}

/* --- the composer stays sendable after a plugin write ----------------- */

{
  const source = fs.readFileSync(PLUGIN, 'utf8');

  // `setDraft` replaces the Lexical document and drops its selection; an editor
  // with no selection has nothing for Enter to submit, which presented as "the
  // Enter key does nothing". Every plugin write must restore the caret.
  const writeFn = source.slice(source.indexOf('const writeDraft = React.useCallback'));
  const writeBody = writeFn.slice(0, writeFn.indexOf('}, [props.inputActions]);'));
  if (/restoreComposerCaret\(\)/.test(writeBody)) {
    ok('every draft write restores the composer caret');
  } else {
    fail('every draft write restores the composer caret', new Error('writeDraft does not restore the caret'));
  }

  // Saving a note unmounts the bubble's textarea, so focus must be handed back
  // explicitly or the reader's next Enter lands on <body>.
  const saveFn = source.slice(source.indexOf('const save = React.useCallback'));
  const saveBody = saveFn.slice(0, saveFn.indexOf('}, [pending, question, store]);'));
  if (/restoreComposerCaret/.test(saveBody)) {
    ok('saving a note returns focus to the composer');
  } else {
    fail('saving a note returns focus to the composer', new Error('save() leaves focus nowhere'));
  }

  // The caret restore must collapse to the end, not select the whole draft
  // (which would make the next keystroke replace everything).
  const caretFn = source.slice(source.indexOf('function restoreComposerCaret'));
  const caretBody = caretFn.slice(0, caretFn.indexOf('\n    }'));
  if (/selectNodeContents\(editor\)/.test(caretBody) && /collapse\(false\)/.test(caretBody)) {
    ok('caret restore collapses to the end of the draft');
  } else {
    fail('caret restore collapses to the end of the draft', new Error('caret not collapsed to end'));
  }
}

/* --- the pending passage stays visibly marked ------------------------- */

{
  const source = fs.readFileSync(PLUGIN, 'utf8');

  // Focusing the field collapses the native selection; the passage must be
  // re-painted as its own Highlight range or the blue mark vanishes.
  if (/function paintPending\(anchor\)/.test(source)) {
    ok('pending passage is painted as a Highlight range');
  } else {
    fail('pending passage is painted as a Highlight range', new Error('no paintPending()'));
  }

  // It needs its own registry name so clearing it cannot wipe saved marks.
  if (/const PENDING_HIGHLIGHT = 'dsm-pending'/.test(source)
    && /::highlight\(dsm-pending\)/.test(source)) {
    ok('pending highlight has its own registry name and rule');
  } else {
    fail('pending highlight has its own registry name and rule', new Error('pending highlight name/rule missing'));
  }

  // It must be driven by the pending state, so it appears with the bubble and
  // clears when the annotation is committed or cancelled.
  if (/paintPending\(pending === null \? null : pending\.anchor\)/.test(source)) {
    ok('pending highlight follows the pending selection');
  } else {
    fail('pending highlight follows the pending selection', new Error('not wired to pending state'));
  }

  // The send must wait for the mirror to publish, not fire on a fixed guess.
  // Pinning the readiness CONDITION matters, not just the retry counter: a
  // mutant that forces readiness true keeps the counter but sends too early.
  const waitsForDraft = /const ready = actions !== undefined[\s\S]{0,220}?current\.trim\(\) !== ''/.test(source);
  if (waitsForDraft && /attempts >= 12/.test(source) && /requestAnimationFrame\(trySend\)/.test(source)) {
    ok('send waits for the mirrored draft before submitting');
  } else {
    fail('send waits for the mirrored draft before submitting', new Error('readiness is not gated on the draft contents'));
  }
}

/* --- the module must not shadow the browser's CSS object -------------- */

{
  const source = fs.readFileSync(PLUGIN, 'utf8');

  // The CSS Custom Highlight API lives on the global `CSS`. A module-level
  // `const CSS = "…"` shadows it, so `CSS.highlights` reads a string property
  // and every highlight silently stops working — no error, no console message.
  // This shipped once; the guard exists so it cannot ship again.
  const shadowsCss = /(?:^|\n)\s*(?:const|let|var)\s+CSS\s*=/.test(source);
  if (!shadowsCss) {
    ok('stylesheet binding does not shadow the global CSS object');
  } else {
    fail('stylesheet binding does not shadow the global CSS object',
      new Error('a local `CSS` binding shadows CSS.highlights'));
  }

  // Highlights are only reachable through the real global.
  if (/CSS\.highlights/.test(source)) {
    ok('highlights read the global CSS.highlights');
  } else {
    fail('highlights read the global CSS.highlights', new Error('CSS.highlights is gone'));
  }

  // A shadowed binding is only detectable if the stylesheet variable has a name
  // that cannot collide with a browser global.
  const styleBinding = source.match(/(?:const|let|var)\s+(\w+)\s*=\s*`/);
  if (styleBinding !== null && styleBinding[1] !== 'CSS') {
    ok(`stylesheet binding is named ${styleBinding[1]} (no global collision)`);
  } else {
    fail('stylesheet binding has a non-colliding name', new Error('stylesheet binding is missing or named CSS'));
  }
}

/* --- every `h()` first argument must be renderable ------------------- */

{
  const source = fs.readFileSync(PLUGIN, 'utf8');
  // Collect bare identifiers and member expressions used as element types.
  const types = new Set();
  for (const match of source.matchAll(/h\(\s*([A-Za-z_$][\w$.]*)\s*[,)]/g)) types.add(match[1]);
  const htmlTags = new Set([
    'div', 'span', 'button', 'textarea', 'blockquote', 'svg', 'path', 'input',
    'p', 'a', 'ul', 'li', 'pre', 'code'
  ]);
  const suspicious = [...types].filter((type) => {
    if (htmlTags.has(type)) return false;
    if (type === 'React.Fragment') return false;
    // A component reference must be a declared function in this module.
    return !new RegExp(`function\\s+${type}\\b|const\\s+${type}\\s*=`, 'm').test(source);
  });
  if (suspicious.length === 0) ok(`all ${types.size} element types resolve to a tag or declared component`);
  else fail('all element types resolve to a tag or declared component', new Error(JSON.stringify(suspicious)));
}

console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
