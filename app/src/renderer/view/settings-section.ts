// The settings-menu component leaf (map §3.1 renderer/view/settings-section.ts):
// one titled radio section and its selection badges. Extracted from entry.ts so
// the live-session menus (composer.ts) and the New Chat launch menus (entry.ts)
// render the SAME component from a shared leaf instead of composer reaching
// sideways into the entry family (import-fence: view families never import each
// other — a leaf may be shared by both).
//
// Pure DOM: it reads no state and imports nothing renderer-internal — every
// choice arrives as `options`/`selected` and every mutation leaves through the
// caller's `onSelect`.

/** One titled radio section of a settings popover (Reasoning / Model / …).
 *  Shared so the live session's model+effort menu (composer.ts, S1) renders the
 *  same component as the New Chat launch menu — one visual family, one selection
 *  grammar. */
export function renderSettingSection<T extends string | null>(
  label: string,
  options: Array<{ label: string; value: T }>,
  selected: T,
  onSelect: (value: T) => void,
  /** STAGED mode (S7 Part 1): `selected` is the STAGED pick (the one Save applies —
   *  the "selected" badge), and `current` marks the session's live value with a muted
   *  "Current" badge when it differs. Omit for immediate-apply menus (new-chat, the
   *  access menus): only the `selected` badge renders, as before. */
  extra?: { current?: T },
): HTMLElement {
  const section = document.createElement("div");
  section.className = "task-setting-section";

  const title = document.createElement("p");
  title.className = "task-setting-heading";
  title.textContent = label;
  section.append(title);

  const hasCurrent = extra !== undefined && "current" in extra;
  for (const option of options) {
    const button = document.createElement("button");
    button.className = "task-setting-option";
    const isSelected = option.value === selected;
    const isCurrent = hasCurrent && option.value === extra?.current;
    button.classList.toggle("selected", isSelected);
    // The current-but-not-staged row reads as "where you are" without the strong
    // staged highlight — a hairline outline distinguishes it (see .is-current CSS).
    button.classList.toggle("is-current", isCurrent && !isSelected);
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.ariaChecked = String(isSelected);
    button.textContent = option.label;
    if (isSelected) {
      button.append(selectedBadge());
    } else if (isCurrent) {
      button.append(currentBadge());
    }
    button.addEventListener("click", () => {
      onSelect(option.value);
    });
    section.append(button);
  }

  return section;
}

/** The "selected" badge on the active row. Also used by the other entry-family
 *  menu builders (provider / project / speed), so it lives on this shared leaf. */
export function selectedBadge(): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "task-setting-badge";
  badge.textContent = "selected";
  return badge;
}

/** The session's live value in a STAGED menu (S7): muted, so the accent-marked
 *  staged pick reads as the pending change and this reads as the current state. */
function currentBadge(): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "task-setting-badge task-setting-badge-current";
  badge.textContent = "Current";
  return badge;
}
