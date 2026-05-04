export interface DirectToDeviceEduContent {
  sender: string;
  type: string;
  message_id: string;
  messages: Record<string, Record<string, Record<string, unknown>>>;
}

export interface ToDeviceDispatchPlan {
  localMessages: Array<{
    recipientUserId: string;
    recipientDeviceId: string;
    senderUserId: string;
    eventType: string;
    content: Record<string, unknown>;
    messageId: string;
  }>;
  remoteMessages: Array<{
    destination: string;
    senderUserId: string;
    eventType: string;
    messageId: string;
    messages: Record<string, Record<string, Record<string, unknown>>>;
  }>;
}

export interface ToDeviceCommandInput {
  senderUserId: string;
  eventType: string;
  txnId: string;
  messages: Record<string, Record<string, Record<string, unknown>>>;
}

export interface ToDeviceCommandPorts {
  localServerName: string;
  getUserDevices(userId: string): Promise<string[]>;
  nextStreamPosition(streamName: string): Promise<number>;
  storeLocalMessage(input: {
    recipientUserId: string;
    recipientDeviceId: string;
    senderUserId: string;
    eventType: string;
    content: Record<string, unknown>;
    messageId: string;
    streamPosition: number;
  }): Promise<void>;
  queueEdu(destination: string, content: DirectToDeviceEduContent): Promise<void>;
  debugEnabled?: boolean | undefined;
}

export interface ToDeviceBatch {
  events: Array<{ sender: string; type: string; content: Record<string, unknown> }>;
  nextBatch: string;
}
