export interface FilterDefinition {
  room?: {
    rooms?: string[];
    not_rooms?: string[];
    timeline?: {
      types?: string[];
      not_types?: string[];
      senders?: string[];
      not_senders?: string[];
      limit?: number;
      lazy_load_members?: boolean;
      unread_thread_notifications?: boolean;
    };
    state?: {
      types?: string[];
      not_types?: string[];
      senders?: string[];
      not_senders?: string[];
      limit?: number;
      lazy_load_members?: boolean;
    };
    ephemeral?: {
      types?: string[];
      not_types?: string[];
      senders?: string[];
      not_senders?: string[];
      limit?: number;
    };
    account_data?: {
      types?: string[];
      not_types?: string[];
      senders?: string[];
      not_senders?: string[];
      limit?: number;
    };
    include_leave?: boolean;
  };
  presence?: {
    types?: string[];
    not_types?: string[];
    senders?: string[];
    not_senders?: string[];
    limit?: number;
  };
  account_data?: {
    types?: string[];
    not_types?: string[];
    senders?: string[];
    not_senders?: string[];
    limit?: number;
  };
  event_format?: "client" | "federation";
  event_fields?: string[];
}
