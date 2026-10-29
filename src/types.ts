// Octopus Energy GraphQL API types for Saving Sessions (backend API)

// --- Token ---
export interface KrakenTokenResponse {
  data: {
    obtainKrakenToken: {
      token: string;
    };
  };
}

// --- Query: savingSessions ---

export interface TargetRegion {
  regionId: string;
}

export interface SignedUpMeterPoint {
  regionId: string;
}

export interface SavingSessionEvent {
  id: string;
  code: string;
  rewardPerKwhInOctoPoints: number;
  startAt: string;
  endAt: string;
  devEvent: boolean;
  targetRegion: TargetRegion;
}

export interface JoinedEvent {
  eventId: string;
  startAt: string;
  endAt: string;
  rewardGivenInOctoPoints: number;
}

export interface SavingSessionAccount {
  signedUpMeterPoint: SignedUpMeterPoint;
  hasJoinedCampaign: boolean;
  joinedEvents: JoinedEvent[];
}

export interface SavingSessionsData {
  events: SavingSessionEvent[];
  account: SavingSessionAccount;
}

export interface SavingSessionsResponse {
  data: {
    savingSessions: SavingSessionsData;
  };
}

// --- Mutation: joinSavingSessionsEvent ---

export interface JoinSavingSessionResponse {
  data: {
    joinSavingSessionsEvent: {
      joinedEventCodes: string[];
    };
  };
}

// Extend the generated Env interface with secret bindings (not in wrangler.jsonc)
declare global {
  interface Env {
    // Secrets (set via `npx wrangler secret put`)
    OCTOPUS_API_KEY: string;
    ACCOUNT_NUMBER: string;
    EMAIL_FROM: string;
    EMAIL_TO: string;
    AWS_ACCESS_KEY_ID?: string;
    AWS_SECRET_ACCESS_KEY?: string;
  }
}

export {};
