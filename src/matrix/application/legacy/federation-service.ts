import type { AppContext } from "../../../shared/runtime/app-context";
import type {
  DeliveryQueue,
  DiscoveryService,
  RemoteKeyCache,
  SignedTransport,
} from "../../../features/federation-core/contracts";
import type { FederationRepository } from "../../../infra/repositories/interfaces";
import { runFederationEffect } from "../runtime/effect-runtime";
import {
  processFederationTransaction,
  type FederationTransactionPorts,
} from "../../../features/federation-core/transaction";
import type {
  FederationTransactionEnvelope,
  FederationTransactionResult,
} from "../../../features/federation-core/contracts";

interface CachedKeyRecord {
  keyId: string;
  key: string;
}

export type FederationTransactionInput = FederationTransactionEnvelope;

export class MatrixFederationService {
  private readonly ports: FederationTransactionPorts;

  constructor(
    private readonly appContext: AppContext,
    private readonly repository: FederationRepository,
    private readonly signedTransport: SignedTransport,
    private readonly discoveryService: DiscoveryService,
    private readonly deliveryQueue: DeliveryQueue,
    private readonly remoteKeyCache: RemoteKeyCache<CachedKeyRecord>,
  ) {
    void this.discoveryService;
    void this.deliveryQueue;
    void this.remoteKeyCache;

    this.ports = {
      appContext: this.appContext,
      repository: this.repository,
      signedTransport: this.signedTransport,
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
