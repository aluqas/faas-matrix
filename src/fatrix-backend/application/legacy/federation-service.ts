import { Effect } from "effect";
import type { AppContext } from "../../ports/runtime/app-context";
import type {
  DeliveryQueue,
  DiscoveryService,
  RemoteKeyCache,
  SignedTransport,
} from "../federation/transactions/contracts";
import type { FederationRepository } from "../../ports/repositories";
import { runFederationEffect } from "../runtime/effect-runtime";
import {
  processFederationTransaction,
  type FederationTransactionPorts,
} from "../federation/transactions/transaction";
import type { FederationEduHandlers } from "../federation/transactions/edu-ingest";
import type {
  FederationTransactionEnvelope,
  FederationTransactionResult,
} from "../federation/transactions/contracts";

interface CachedKeyRecord {
  keyId: string;
  key: string;
}

export type FederationTransactionInput = FederationTransactionEnvelope;

const noopEduHandlers: FederationEduHandlers = {
  typing: {
    membership: {
      getMembership: () => Effect.succeed(null),
      isPartialStateRoom: () => Effect.succeed(false),
    },
    typingState: {
      setRoomTyping: () => Effect.void,
    },
  },
  receipts: {
    membership: {
      getMembership: () => Effect.succeed(null),
      isPartialStateRoom: () => Effect.succeed(false),
    },
    roomReceiptStore: {
      putReceipt: () => Effect.void,
    },
  },
  directToDevice: {
    ingest: () => Promise.resolve(),
  },
};

export class MatrixFederationService {
  private readonly ports: FederationTransactionPorts;

  constructor(
    private readonly appContext: AppContext,
    private readonly repository: FederationRepository,
    private readonly signedTransport: SignedTransport,
    private readonly discoveryService: DiscoveryService,
    private readonly deliveryQueue: DeliveryQueue,
    private readonly remoteKeyCache: RemoteKeyCache<CachedKeyRecord>,
    private readonly eduHandlers: FederationEduHandlers = noopEduHandlers,
  ) {
    void this.discoveryService;
    void this.deliveryQueue;
    void this.remoteKeyCache;

    this.ports = {
      appContext: this.appContext,
      repository: this.repository,
      signedTransport: this.signedTransport,
      eduHandlers: this.eduHandlers,
      runEffect: runFederationEffect,
    };
  }

  async processTransaction(
    input: FederationTransactionInput,
  ): Promise<{ pdus: Record<string, unknown> }> {
    const result: FederationTransactionResult = await processFederationTransaction(
      this.ports,
      input,
    );
    return { pdus: result.pdus };
  }
}
