import type { AppEnv } from "../../shared/types";
import {
  fromInfraNullable,
  fromInfraPromise,
  fromInfraVoid,
} from "../../shared/effect/infra-effect";
import {
  findStoredTransactionResponse,
  getNextNamedStreamPosition,
  insertToDeviceMessage,
  listUserDeviceIds,
  storeTransactionResponse,
} from "../../infra/repositories/to-device-repository";
import { queueFederationEdu } from "../shared/federation-edu-queue";
import type { ToDeviceCommandInput } from "./contracts";
import { dispatchToDeviceMessages, type ToDeviceRequestPorts } from "./command";

export function createToDeviceRequestPorts(
  env: Pick<AppEnv["Bindings"], "DB" | "SERVER_NAME"> & AppEnv["Bindings"],
  debugEnabled: boolean,
): ToDeviceRequestPorts {
  return {
    transactionStore: {
      getTransactionResponse: (userId, txnId) =>
        fromInfraNullable(
          () =>
            findStoredTransactionResponse(
              env.DB,
              userId as import("../../shared/types").UserId,
              txnId,
            ),
          "Failed to load to-device transaction",
        ),
      storeTransactionResponse: (userId, txnId, response) =>
        fromInfraVoid(
          () =>
            storeTransactionResponse(
              env.DB,
              userId as import("../../shared/types").UserId,
              txnId,
              response,
            ),
          "Failed to store to-device transaction",
        ),
    },
    dispatcher: {
      dispatch: (input: ToDeviceCommandInput) =>
        fromInfraPromise(
          () =>
            dispatchToDeviceMessages(input, {
              localServerName: env.SERVER_NAME,
              getUserDevices: (recipientUserId: string) =>
                listUserDeviceIds(env.DB, recipientUserId as import("../../shared/types").UserId),
              nextStreamPosition: (streamName: string) =>
                getNextNamedStreamPosition(env.DB, streamName),
              storeLocalMessage: (message) => insertToDeviceMessage(env.DB, message),
              queueEdu: (destination, content) =>
                queueFederationEdu(env, destination, "m.direct_to_device", content),
              debugEnabled,
            }),
          "Failed to dispatch to-device messages",
        ),
    },
  };
}
