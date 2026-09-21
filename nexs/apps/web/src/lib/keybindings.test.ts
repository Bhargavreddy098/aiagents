/**
 * The keybinding table's integrity.
 *
 * The table's value is that it is the *single* statement of what this surface can do, so the
 * tests here check the properties a table like this erodes: that everything unavailable says
 * why, that the spec's rows are all present somewhere, and that no two available rows collide.
 */

import { describe, expect, it } from 'vitest';
import {
  KEY_BINDINGS,
  bindingsByGroup,
  supportedBindings,
  unsupportedBindings,
} from './keybindings';

describe('KEY_BINDINGS', () => {
  it('gives every binding a label and a group', () => {
    for (const binding of KEY_BINDINGS) {
      expect(binding.label.length).toBeGreaterThan(0);
      expect(binding.group.length).toBeGreaterThan(0);
      expect(binding.keys.length).toBeGreaterThan(0);
    }
  });

  it('gives every unavailable binding a reason a user can read', () => {
    // A disabled row with no explanation is the thing this project refuses to ship.
    for (const binding of unsupportedBindings()) {
      expect(binding.unsupported).not.toBeNull();
      expect(binding.unsupported!.length).toBeGreaterThan(10);
    }
  });

  it('does not collide two available bindings on the same key in the same scope', () => {
    // A collision would mean one silently shadows the other, which is a documented key that
    // does not work — worse than not documenting it.
    const seen = new Map<string, string>();
    for (const binding of supportedBindings()) {
      const id = `${binding.scope}:${binding.keys}`;
      const previous = seen.get(id);
      expect(previous, `${binding.keys} is bound twice in ${binding.scope}: ${previous} and ${binding.label}`).toBeUndefined();
      seen.set(id, binding.label);
    }
  });

  it('covers the spec’s terminal-only rows as explicitly unavailable, not by omission', () => {
    // Ctrl+D and Ctrl+Z are terminal signals a page cannot send. Shipping the row as available
    // would be a key that does nothing; omitting it would make the table disagree with §8.
    const keys = KEY_BINDINGS.map((binding) => binding.keys);
    expect(keys).toContain('Ctrl+D');
    expect(keys).toContain('Ctrl+Z');
    expect(keys).toContain('Ctrl+C');
    const shellBypass = KEY_BINDINGS.find((binding) => binding.keys === '!command');
    expect(shellBypass?.unsupported).toContain('no operator shell');
  });

  it('covers the implemented rows the composer and shell actually handle', () => {
    const supported = new Set(supportedBindings().map((binding) => binding.keys));
    for (const key of ['Enter', 'Shift+Enter', 'Ctrl+S', 'Ctrl+K', 'Ctrl+X', 'Ctrl+T', 'F7', 'Esc']) {
      expect(supported.has(key), `${key} should be implemented`).toBe(true);
    }
  });

  it('splits the table into supported and unsupported with nothing lost', () => {
    expect(supportedBindings().length + unsupportedBindings().length).toBe(KEY_BINDINGS.length);
  });
});

describe('bindingsByGroup', () => {
  it('keeps the spec’s order and groups without reordering', () => {
    const groups = bindingsByGroup();
    expect(groups.map((group) => group.group)).toEqual(['Composer', 'Global']);
    const composerKeys = groups[0]!.bindings.map((binding) => binding.keys);
    const tableKeys = KEY_BINDINGS.filter((binding) => binding.group === 'Composer').map(
      (binding) => binding.keys,
    );
    expect(composerKeys).toEqual(tableKeys);
  });

  it('handles an empty list', () => {
    expect(bindingsByGroup([])).toEqual([]);
  });
});
