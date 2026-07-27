// The slash-command picker's render surface (map §3.1
// renderer/view/slash-picker.ts, D3 — moved verbatim from main.ts): the
// listbox, its options, and the composer-anchored positioner (live geometry
// read each render). Seam decision (D3, logged): handleSlashPickerKeydown
// STAYS in the shell — it is input grammar gated by the G2 IME guard
// (composerIsComposing, shell module state) and every branch drives a shell
// flow (move/close/complete/execute); only rendering lives here. Option
// clicks route through actions.executeSlashEntry; the mousemove hover
// (selection follow + composer-popover repaint) is grammar → actions.

import type { SlashCommandEntry } from "../../shared/types";
import { filteredSlashItems } from "../../reading-core/selectors/composer";
import type { SlashPickerState } from "../../reading-core/state";
import { elements } from "../dom";
import { actions } from "../actions";

export function renderSlashPicker(picker: SlashPickerState): HTMLElement {
  const root = document.createElement("div");
  root.className = "slash-picker";
  root.setAttribute("role", "listbox");
  root.setAttribute("aria-label", "Commands");

  const items = filteredSlashItems(picker);
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "slash-picker-empty";
    empty.textContent = "No commands";
    root.append(empty);
    return root;
  }

  let lastKind: SlashCommandEntry["kind"] | null = null;
  items.forEach((entry, index) => {
    if (entry.kind !== lastKind) {
      const heading = document.createElement("p");
      heading.className = "slash-picker-heading";
      heading.textContent = entry.kind === "skill" ? "Skills" : "Commands";
      root.append(heading);
      lastKind = entry.kind;
    }
    root.append(renderSlashPickerOption(entry, index, picker));
  });
  return root;
}

function renderSlashPickerOption(
  entry: SlashCommandEntry,
  index: number,
  picker: SlashPickerState,
): HTMLElement {
  const option = document.createElement("button");
  option.type = "button";
  option.className = "slash-picker-option";
  option.classList.toggle("selected", index === picker.selectedIndex);
  option.setAttribute("role", "option");
  option.ariaSelected = String(index === picker.selectedIndex);

  const name = document.createElement("span");
  name.className = "slash-picker-name";
  name.textContent = entry.invocation;
  option.append(name);

  if (entry.argumentHint) {
    const hint = document.createElement("span");
    hint.className = "slash-picker-hint";
    hint.textContent = entry.argumentHint;
    option.append(hint);
  }

  const description = document.createElement("span");
  description.className = "slash-picker-description";
  description.textContent = entry.description;
  option.append(description);

  if (entry.kind === "skill" && entry.scope !== "builtin") {
    const badge = document.createElement("span");
    badge.className = "slash-picker-badge";
    badge.textContent =
      entry.scope === "project" ? "Project" : entry.scope === "system" ? "System" : "Personal";
    option.append(badge);
  }

  // Keep composer focus so a click acts like Enter instead of blurring.
  option.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  option.addEventListener("click", () => {
    actions.executeSlashEntry(entry);
  });
  option.addEventListener("mousemove", () => {
    actions.hoverSlashOption(picker, index);
  });
  return option;
}

export function positionSlashPicker(pickerElement: HTMLElement): void {
  const rect = elements.composer.getBoundingClientRect();
  const viewportPadding = 14;
  const width = Math.min(rect.width, window.innerWidth - viewportPadding * 2);
  pickerElement.style.width = `${width}px`;
  pickerElement.style.left = `${Math.max(viewportPadding, rect.left)}px`;
  const top = rect.top - pickerElement.offsetHeight - 8;
  pickerElement.style.top = `${Math.max(viewportPadding, top)}px`;
  const selected = pickerElement.querySelector<HTMLElement>(".slash-picker-option.selected");
  selected?.scrollIntoView({ block: "nearest" });
}
