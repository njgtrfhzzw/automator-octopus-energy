import type {
  KrakenTokenResponse,
  SavingSessionsResponse,
  SavingSessionEvent,
  JoinedEvent,
  JoinSavingSessionResponse,
} from "./types";

interface GraphQLErrorDetail {
  message: string;
  locations?: { line: number; column: number }[];
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
}

export class GraphQLRequestError extends Error {
  constructor(
    message: string,
    public readonly errors: GraphQLErrorDetail[],
  ) {
    super(message);
    this.name = "GraphQLRequestError";
  }
}

/** Error thrown when the backend API is temporarily unavailable (HTTP 5xx, e.g. 503). */
export class BackendUnavailableError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BackendUnavailableError";
  }
}

/** Flatten a GraphQL error (message + extensions + path) into a single line for logging. */
function describeGraphQLError(error: GraphQLErrorDetail): string {
  const parts: string[] = [error.message];
  const ext = error.extensions;
  if (ext) {
    if (typeof ext.errorCode === "string") parts.push(`errorCode=${ext.errorCode}`);
    if (typeof ext.errorType === "string") parts.push(`errorType=${ext.errorType}`);
    if (typeof ext.errorDescription === "string") parts.push(`errorDescription=${ext.errorDescription}`);
    if (typeof ext.reason === "string") parts.push(`reason=${ext.reason}`);
  }
  if (error.path && error.path.length > 0) {
    parts.push(`path=${error.path.join(".")}`);
  }
  return parts.join(" | ");
}

/** Main Octopus API — used for obtaining the Kraken token */
const MAIN_GRAPHQL_URL = "https://api.octopus.energy/v1/graphql/";

/** Backend Octopus API — used for saving sessions queries/mutations */
const BACKEND_GRAPHQL_URL = "https://api.backend.octopus.energy/v1/graphql/";

export interface SavingSessionResult {
  events: SavingSessionEvent[];
  joinedEvents: JoinedEvent[];
  hasJoinedCampaign: boolean;
}

export class OctopusClient {
  constructor(
    private apiKey: string,
    private accountNumber: string,
  ) {}

  /** Obtain a short-lived Kraken JWT token from the API key */
  private async getToken(): Promise<string> {
    const query = `mutation {
      obtainKrakenToken(input: { APIKey: "${this.apiKey}" }) {
        token
      }
    }`;

    const response = await fetch(MAIN_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`Failed to obtain Kraken token: ${response.status}`);
    }

    const data = (await response.json()) as KrakenTokenResponse;

    if (data.data?.obtainKrakenToken?.token) {
      return data.data.obtainKrakenToken.token;
    }

    throw new Error("No token in Kraken response");
  }

  /** Execute a GraphQL query on the backend API */
  private async backendRequest<T>(query: string): Promise<T> {
    const token = await this.getToken();

    const response = await fetch(BACKEND_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Backend API uses bare token, not "JWT {token}"
        Authorization: token,
        "User-Agent": "automator-octopus-energy/1.0",
        Accept: "application/json",
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      const message =
        `Backend GraphQL request failed: ${response.status} ${response.statusText} — ${bodyText.slice(0, 500)}`;

      // Transient server errors (5xx, e.g. 503 Service Unavailable) mean the
      // backend is temporarily down, not that our code is broken — these are
      // classified separately so alerts can be suppressed.
      if (response.status >= 500) {
        throw new BackendUnavailableError(response.status, message);
      }

      throw new Error(message);
    }

    const data = (await response.json()) as T;

    const errors = (data as { errors?: GraphQLErrorDetail[] }).errors;
    if (errors && errors.length > 0) {
      console.error(`GraphQL errors: ${JSON.stringify(errors)}`);
      throw new GraphQLRequestError(
        `GraphQL errors: ${errors.map(describeGraphQLError).join("; ")}`,
        errors,
      );
    }

    return data;
  }

  /** Get saving sessions: available events + account joined events */
  async getSavingSessions(): Promise<SavingSessionResult> {
    const query = `query {
      savingSessions {
        events(includeDev: false) {
          id
          code
          rewardPerKwhInOctoPoints
          startAt
          endAt
          devEvent
          targetRegion {
            regionId
          }
        }
        account(accountNumber: "${this.accountNumber}") {
          signedUpMeterPoint {
            regionId
          }
          hasJoinedCampaign
          joinedEvents {
            eventId
            startAt
            endAt
            rewardGivenInOctoPoints
          }
        }
      }
    }`;

    const data = await this.backendRequest<SavingSessionsResponse>(query);
    const ss = data.data.savingSessions;
    return {
      events: ss.events,
      joinedEvents: ss.account.joinedEvents,
      hasJoinedCampaign: ss.account.hasJoinedCampaign,
    };
  }

  /** Join a saving session event */
  async joinSession(eventCode: string): Promise<string[]> {
    const query = `mutation {
      joinSavingSessionsEvent(input: {
        accountNumber: "${this.accountNumber}"
        eventCode: "${eventCode}"
      }) {
        joinedEventCodes
      }
    }`;

    const data = await this.backendRequest<JoinSavingSessionResponse>(query);
    return data.data.joinSavingSessionsEvent.joinedEventCodes;
  }
}
