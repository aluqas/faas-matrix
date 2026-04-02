import { Effect } from "effect";
import type { AppContext } from "../../../../foundation/app-context";
import type { SignedTransport } from "../../../../fedcore/contracts";
import type { FederationRepository } from "../../../repositories/interfaces";
import { emitEffectWarningEffect } from "../../effect-debug";
import { requireLogContext, withLogContext } from "../../logging";
import { type FederationTransactionEnvelope, type FederationTransactionResult } from "./contracts";
import { ingestFederationEdu } from "./edu-ingest";
import { ingestFederationPdu } from "./pdu-ingest";

export interface FederationTransactionPorts {
  appContext: AppContext;
  repository: FederationRepository;
  signedTransport: SignedTransport;
  runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A>;
}

export async function processFederationTransaction(
  ports: FederationTransactionPorts,
  input: FederationTransactionEnvelope,
): Promise<FederationTransactionResult> {
  const logger = withLogContext(
    requireLogContext(
      "federation.transaction",
      {
        component: "federation",
        operation: "transaction",
        origin: input.origin,
        txn_id: input.txnId,
        debugEnabled: ports.appContext.profile.name === "complement",
      },
      ["origin", "txn_id"],
    ),
  );
  await ports.runEffect(
    logger.info("federation.transaction.start", {
      pdu_count: input.body.pdus?.length ?? 0,
      edu_count: input.body.edus?.length ?? 0,
    }),
  );
  await ports.runEffect(
    emitEffectWarningEffect("[federation.transaction] start", {
      origin: input.origin,
      txnId: input.txnId,
      pdus: input.body.pdus?.length ?? 0,
      edus: input.body.edus?.length ?? 0,
    }),
  );

  const cached = await ports.repository.getCachedTransaction(input.origin, input.txnId);
  if (cached) {
    const cachedPdus =
      "pdus" in cached && cached["pdus"] && typeof cached["pdus"] === "object"
        ? (cached["pdus"] as Record<string, unknown>)
        : (cached as Record<string, unknown>);
    return {
      pdus: cachedPdus,
      acceptedPduCount: 0,
      rejectedPduCount: 0,
      processedEduCount: 0,
      softFailedEventIds: [],
    };
  }

  const result: FederationTransactionResult = {
    pdus: {},
    acceptedPduCount: 0,
    rejectedPduCount: 0,
    processedEduCount: 0,
    softFailedEventIds: [],
  };

  const processNestedTransaction = (nestedInput: FederationTransactionEnvelope) =>
    processFederationTransaction(ports, nestedInput);

  for (const rawPdu of input.body.pdus || []) {
    const pduResult = await ingestFederationPdu(
      {
        appContext: ports.appContext,
        repository: ports.repository,
        signedTransport: ports.signedTransport,
        processTransaction: processNestedTransaction,
        runEffect: ports.runEffect,
      },
      {
        origin: input.origin,
        txnId: input.txnId,
        rawPdu,
        ...(input.disableGapFill !== undefined ? { disableGapFill: input.disableGapFill } : {}),
        ...(input.historicalOnly !== undefined ? { historicalOnly: input.historicalOnly } : {}),
      },
      logger,
    );

    if (pduResult.kind === "accepted") {
      result.pdus[pduResult.eventId] = {};
      result.acceptedPduCount += 1;
      await ports.runEffect(
        logger.info("federation.pdu.accepted", {
          event_id: pduResult.eventId,
        }),
      );
      continue;
    }

    if (pduResult.kind === "soft_failed") {
      result.pdus[pduResult.eventId] = {};
      result.rejectedPduCount += 1;
      result.softFailedEventIds.push(pduResult.eventId);
      await ports.runEffect(
        logger.warn("federation.pdu.soft_failed", {
          event_id: pduResult.eventId,
          error_message: pduResult.reason,
        }),
      );
      continue;
    }

    if (pduResult.kind === "ignored") {
      result.pdus[pduResult.eventId] = {};
      continue;
    }

    result.pdus[pduResult.eventId] = {
      error: pduResult.reason || "Unknown error",
    };
    result.rejectedPduCount += 1;
    await ports.runEffect(
      logger.warn("federation.pdu.rejected", {
        event_id: pduResult.eventId,
        error_message: pduResult.reason || "Unknown error",
      }),
    );
  }

  for (const rawEdu of input.body.edus || []) {
    try {
      const eduResult = await ingestFederationEdu(
        {
          appContext: ports.appContext,
          repository: ports.repository,
          runEffect: ports.runEffect,
        },
        { origin: input.origin, rawEdu },
      );
      if (eduResult.kind === "applied") {
        result.processedEduCount += 1;
        await ports.runEffect(
          logger.info("federation.edu.applied", {
            edu_type: eduResult.eduType,
            room_count: eduResult.roomIds.length,
          }),
        );
      } else if (eduResult.kind === "rejected") {
        await ports.runEffect(
          logger.warn("federation.edu.rejected", {
            edu_type: eduResult.eduType,
            error_message: eduResult.reason,
          }),
        );
      }
    } catch (error) {
      await ports.runEffect(
        logger.warn("federation.transaction.edu_error", {
          edu_type: typeof rawEdu["edu_type"] === "string" ? rawEdu["edu_type"] : undefined,
          error_message: error instanceof Error ? error.message : String(error),
        }),
      );
      await ports.runEffect(
        emitEffectWarningEffect("[federation.transaction] EDU error", {
          origin: input.origin,
          eduType: typeof rawEdu["edu_type"] === "string" ? rawEdu["edu_type"] : undefined,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  await ports.repository.storeCachedTransaction(input.origin, input.txnId, {
    pdus: result.pdus,
  });

  await ports.runEffect(
    logger.info("federation.transaction.result", {
      accepted_pdu_count: result.acceptedPduCount,
      rejected_pdu_count: result.rejectedPduCount,
      processed_edu_count: result.processedEduCount,
      soft_failed_count: result.softFailedEventIds.length,
    }),
  );

  return result;
}
