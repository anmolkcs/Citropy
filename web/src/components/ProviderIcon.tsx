import claude from "../assets/providers/claude-light.svg";
import codexLight from "../assets/providers/chatgpt-light.svg";
import codexDark from "../assets/providers/chatgpt-dark.svg";
import cursorLight from "../assets/providers/cursor-light.svg";
import cursorDark from "../assets/providers/cursor-dark.svg";
import opencodeLight from "../assets/providers/opencode-light.svg";
import opencodeDark from "../assets/providers/opencode-dark.svg";
import piLight from "../assets/providers/pi-light.svg";
import piDark from "../assets/providers/pi-dark.svg";
import customLight from "../assets/providers/custom-light.svg";
import customDark from "../assets/providers/custom-dark.svg";
import { useApp } from "../lib/store.ts";
import type { ProviderId } from "../../../shared/protocol.ts";

const logos = {
  claude: { light: claude, dark: claude },
  codex: { light: codexLight, dark: codexDark },
  cursor: { light: cursorLight, dark: cursorDark },
  opencode: { light: opencodeLight, dark: opencodeDark },
  pi: { light: piLight, dark: piDark },
  custom: { light: customLight, dark: customDark },
};

export function ProviderIcon({ provider }: { provider: ProviderId }) {
  const scheme = useApp((state) => state.scheme);
  return (
    <img
      className="provider-icon"
      data-provider={provider}
      src={logos[provider][scheme]}
      width={20}
      height={20}
      alt=""
      aria-hidden="true"
      style={{ flexShrink: 0, objectFit: "contain" }}
    />
  );
}
