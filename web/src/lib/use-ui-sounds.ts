import { useEffect } from "react";
import { useApp } from "./store.ts";
import {
  configureUiSounds,
  playUiSound,
  unlockUiSounds,
  type UiSound,
} from "./ui-sound.ts";

const SILENT =
  ".xterm, textarea, select, [contenteditable='true'], [data-ui-sound='off'], input:not([type='checkbox']):not([type='radio'])";
const PRESSABLE =
  "button, [role='button'], [role='tab'], [role='menuitem'], [role='option'], a[href], summary, label, input[type='checkbox'], input[type='radio']";
const TOGGLES =
  "input[type='checkbox'], input[type='radio'], [role='switch'], [role='checkbox'], [role='radio']";
const NAVIGATION =
  "a[href], summary, [role='tab'], [role='menuitem'], [role='option']";
const INERT = ":disabled, [aria-disabled='true'], [data-disabled='true']";

function clickSoundFor(target: EventTarget | null): UiSound | null {
  if (!(target instanceof Element)) return null;
  if (target.closest(SILENT)) return null;
  const pressed = target.closest(PRESSABLE);
  if (!pressed || pressed.closest(INERT)) return null;
  const control = pressed.matches(TOGGLES)
    ? pressed
    : pressed.matches("label")
      ? pressed.querySelector(TOGGLES)
      : null;
  if (control) {
    if (control.matches(INERT)) return null;
    const on =
      control instanceof HTMLInputElement
        ? !control.checked
        : control.getAttribute("aria-checked") !== "true";
    return on ? "toggle-on" : "toggle-off";
  }
  return pressed.matches(NAVIGATION) ? "nav" : "click";
}

export function useUiSounds(): void {
  const interfaceSounds = useApp((state) => state.uiSounds);
  const alertSounds = useApp((state) => state.uiAlertSounds);
  const volume = useApp((state) => state.uiSoundVolume);

  useEffect(() => {
    configureUiSounds({ volume, interfaceSounds, alertSounds });
  }, [volume, interfaceSounds, alertSounds]);

  useEffect(() => {
    if (!interfaceSounds && !alertSounds) return;
    const unlock = () => unlockUiSounds();
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    return () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
    };
  }, [interfaceSounds, alertSounds]);

  useEffect(() => {
    const press = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const sound = clickSoundFor(event.target);
      if (sound) playUiSound(sound);
    };
    window.addEventListener("pointerdown", press, true);
    return () => window.removeEventListener("pointerdown", press, true);
  }, []);
}
