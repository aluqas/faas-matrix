import { withLogContext } from "../../logging";

export function createKeysLogger(operation: string, context: Record<string, unknown> = {}) {
  return withLogContext({
    component: "keys",
    operation,
    debugEnabled: true,
    user_id: typeof context["user_id"] === "string" ? context["user_id"] : undefined,
    device_id: typeof context["device_id"] === "string" ? context["device_id"] : undefined,
  });
}
