// The settings-menu component leaf (map §3.1 renderer/view/settings-section.ts):
// one titled radio section and its selection badge. Extracted from entry.ts as a
// shared leaf (import-fence: view families never import each other — a leaf may
// be shared by several).
//
// Pure DOM: it reads no state and imports nothing renderer-internal — every
// choice arrives as `options`/`selected` and every mutation leaves through the
// caller's `onSelect`.

/** One titled radio section of a settings popover (Reasoning / Model / …) —
 *  one visual family, one selection grammar. */
export function renderSettingSection<T extends string | null>(
  label: string,
  options: Array<{ label: string; value: T }>,
  selected: T,
  onSelect: (value: T) => void,
): HTMLElement {
  const section = document.createElement("div");
  section.className = "task-setting-section";

  const title = document.createElement("p");
  title.className = "task-setting-heading";
  title.textContent = label;
  section.append(title);

  for (const option of options) {
    const button = document.createElement("button");
    button.className = "task-setting-option";
    const isSelected = option.value === selected;
    button.classList.toggle("selected", isSelected);
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.ariaChecked = String(isSelected);
    button.textContent = option.label;
    if (isSelected) {
      button.append(selectedBadge());
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
