import type { ClientEvent, ServerEvent } from "../../shared/protocol.ts";

export type Respond = (event: ServerEvent) => void;

type Route<K extends ClientEvent["t"]> = (
  event: Extract<ClientEvent, { t: K }>,
  send: Respond,
) => void | Promise<void>;

export type Routes = { [K in ClientEvent["t"]]?: Route<K> };
