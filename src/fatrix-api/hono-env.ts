import type { AppContext } from "../fatrix-backend/ports/runtime/app-context";
import type { MatrixServiceRegistry } from "../fatrix-backend/service-registry";
import type { AccessToken, DeviceId, UserId } from "../fatrix-model/types/matrix";
import type { Env } from "../platform/cloudflare/env";

export type Variables = {
  userId: UserId;
  deviceId: DeviceId | null;
  accessToken: AccessToken;
  appContext: AppContext<MatrixServiceRegistry>;
  auth: {
    userId: UserId;
    deviceId: DeviceId | null;
    accessToken: AccessToken;
  };
};

export type AppEnv = {
  Bindings: Env;
  Variables: Variables;
};
