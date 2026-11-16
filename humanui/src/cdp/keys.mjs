// Key and modifier translation.
//
// Two vocabularies meet here. Models emit names like "ENTER" / "ARROWDOWN" / "CTRL"
// (the shape OpenAI documents), while CDP wants `key`, `code`, and a Windows virtual key code.
// The name mapping is adapted from the vendor recipe; the virtual key codes are the addition
// needed to drive Input.dispatchKeyEvent directly.

/** Model-emitted key name -> DOM `key` value. From the vendor's normalizeKey helper. */
const KEY_ALIASES = new Map(Object.entries({
  ENTER: 'Enter', RETURN: 'Enter',
  ESC: 'Escape', ESCAPE: 'Escape',
  TAB: 'Tab',
  SPACE: ' ',
  BACKSPACE: 'Backspace',
  DELETE: 'Delete', DEL: 'Delete',
  HOME: 'Home', END: 'End',
  PAGEUP: 'PageUp', PAGEDOWN: 'PageDown',
  UP: 'ArrowUp', ARROWUP: 'ArrowUp',
  DOWN: 'ArrowDown', ARROWDOWN: 'ArrowDown',
  LEFT: 'ArrowLeft', ARROWLEFT: 'ArrowLeft',
  RIGHT: 'ArrowRight', ARROWRIGHT: 'ArrowRight',
  CTRL: 'Control', CONTROL: 'Control',
  SHIFT: 'Shift',
  OPTION: 'Alt', ALT: 'Alt',
  META: 'Meta', CMD: 'Meta', COMMAND: 'Meta', SUPER: 'Meta',
}));

export function normalizeKey(key) {
  return KEY_ALIASES.get(String(key).toUpperCase()) ?? String(key);
}

/** CDP `Input` modifier bitmask. */
export const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export function modifierMask(keys = []) {
  return keys.reduce((mask, k) => mask | (MODIFIER_BITS[normalizeKey(k)] ?? 0), 0);
}

/** `code` value, derived from the DOM key where the mapping is mechanical. */
const CODES = new Map(Object.entries({
  Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Shift: 'ShiftLeft', Control: 'ControlLeft', Alt: 'AltLeft', Meta: 'MetaLeft',
  ' ': 'Space',
}));

/** Windows virtual key codes Chromium expects. */
const VIRTUAL_KEYS = new Map(Object.entries({
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Shift: 16, Control: 17, Alt: 18, Meta: 91, ' ': 32,
  F1: 70, F2: 71, F3: 72, F4: 73, F5: 74, F6: 75,
  F7: 76, F8: 77, F9: 78, F10: 79, F11: 80, F12: 81,
}));

export function keyDefinition(name) {
  const key = normalizeKey(name);
  // A single printable character has no table entry, but Chromium still wants a virtual key code
  // for it; the character's own code point is the conventional value.
  const vk = VIRTUAL_KEYS.get(key) ?? (isPrintable(key) ? key.toUpperCase().charCodeAt(0) : 0);
  return {
    key,
    code: CODES.get(key) ?? '',
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  };
}

/** True for keys that produce a character rather than a command. */
export function isPrintable(key) {
  return typeof key === 'string' && key.length === 1 && key !== '\n' && key !== '\r' && key !== '\t';
}

/** The text a key contributes to an editable field, or '' if it is not a text key. */
export function textForKey(key) {
  if (key === 'Enter') return '\r';
  if (key === 'Tab') return '\t';
  if (isPrintable(key)) return key;
  return '';
}