import { OctopusClient, BackendUnavailableError } from "./octopus";
import { sendEmail } from "./email";

const KV_PREFIX = "joined:";

/** Returns true if AWS SES credentials are configured */
function hasEmail(env: Env): boolean {
  return !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
}

/** Send an email only if AWS credentials are configured */
async function trySendEmail(
  params: { to: string; from: string; subject: string; body: string },
  env: Env,
): Promise<void> {
  if (!hasEmail(env)) {
    console.log(`Email skipped (no AWS creds): ${params.subject}`);
    return;
  }
  await sendEmail(params, env.AWS_ACCESS_KEY_ID!, env.AWS_SECRET_ACCESS_KEY!, env.AWS_REGION);
}

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    console.log("[automator-octopus] Cron triggered — checking for saving sessions…");

    const client = new OctopusClient(env.OCTOPUS_API_KEY, env.ACCOUNT_NUMBER);

    try {
      const result = await client.getSavingSessions();

      // Build a set of already-joined event IDs (from API)
      const joinedEventIds = new Set(result.joinedEvents.map((je) => je.eventId));

      const now = new Date();
      const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

      const availableEvents = result.events.filter((e) => {
        const start = new Date(e.startAt);
        if (e.rewardPerKwhInOctoPoints <= 0) {
          console.log(`Event "${e.code}" started ${e.startAt}, reward=${e.rewardPerKwhInOctoPoints} OctoPoints/kWh — zero reward, skipping.`);
          return false;
        }
        if (start < fiveDaysAgo) {
          console.log(`Event "${e.code}" started ${e.startAt}, reward=${e.rewardPerKwhInOctoPoints} OctoPoints/kWh — older than 5 days, skipping.`);
          return false;
        }
        return true;
      });

      console.log(`Found ${availableEvents.length} event(s) (filtered), ${joinedEventIds.size} already joined`);

      if (availableEvents.length === 0) {
        console.log("No saving sessions available. Nothing to do.");
        return;
      }

      for (const event of availableEvents) {
        const kvKey = `${KV_PREFIX}${event.code}`;

        // Check KV dedup first
        const kvJoined = await env.JOINED_SESSIONS.get(kvKey);
        if (kvJoined) {
          const reason = kvJoined === "ineligible" ? "marked ineligible" : "already joined";
          console.log(`Event "${event.code}" started ${event.startAt}, reward=${event.rewardPerKwhInOctoPoints} OctoPoints/kWh ${reason} (KV) — skipping.`);
          continue;
        }

        // Check if already joined per the API response
        if (joinedEventIds.has(event.id)) {
          console.log(`Event "${event.code}" started ${event.startAt}, reward=${event.rewardPerKwhInOctoPoints} OctoPoints/kWh already joined per API — marking in KV.`);
          await env.JOINED_SESSIONS.put(kvKey, "true", {
            expirationTtl: 60 * 60 * 24 * 30,
          });
          continue;
        }

        console.log(
          `Joining event: "${event.code}" (id=${event.id}, region=${event.targetRegion?.regionId ?? "unknown"}) ` +
            `start=${event.startAt}, end=${event.endAt}, reward=${event.rewardPerKwhInOctoPoints} OctoPoints/kWh`,
        );
        try {
          const joinedCodes = await client.joinSession(event.code);

          if (joinedCodes.includes(event.code)) {
            await env.JOINED_SESSIONS.put(kvKey, "true", {
              expirationTtl: 60 * 60 * 24 * 30,
            });

            const startTime = formatDateTime(event.startAt);
            const endTime = formatDateTime(event.endAt);

            await trySendEmail(
              {
                to: env.EMAIL_TO,
                from: env.EMAIL_FROM,
                subject: `✅ Joined Octopus Saving Session: ${event.code}`,
                body: [
                  "You have successfully joined an Octopus Energy saving session:",
                  "",
                  `Event code: ${event.code}`,
                  `Event ID: ${event.id}`,
                  `Start: ${startTime}`,
                  `End: ${endTime}`,
                  `Reward: ${event.rewardPerKwhInOctoPoints} OctoPoints/kWh`,
                  "",
                  "— automator-octopus-energy",
                ].join("\n"),
              },
              env,
            );
          } else {
            console.error(`Join returned but did not include code "${event.code}": ${joinedCodes}`);
            await trySendEmail(
              {
                to: env.EMAIL_TO,
                from: env.EMAIL_FROM,
                subject: `⚠️ Octopus Saving Session join failed: ${event.code}`,
                body: [
                  "Failed to join the Octopus Energy saving session.",
                  "",
                  `Event code: ${event.code}`,
                  `Event ID: ${event.id}`,
                  `Start: ${formatDateTime(event.startAt)}`,
                  `End: ${formatDateTime(event.endAt)}`,
                  `Reward: ${event.rewardPerKwhInOctoPoints} OctoPoints/kWh`,
                ].join("\n"),
              },
              env,
            );
          }
        } catch (joinError) {
          const msg = joinError instanceof Error ? joinError.message : String(joinError);

          if (msg.toLowerCase().includes("ineligible")) {
            // Account is ineligible for this event — record in KV so we don't keep retrying
            console.log(`Event "${event.code}" (reward=${event.rewardPerKwhInOctoPoints} OctoPoints/kWh) — account ineligible, marking in KV.`);
            await env.JOINED_SESSIONS.put(kvKey, "ineligible", {
              expirationTtl: 60 * 60 * 24 * 30,
            });
          } else if (msg.toLowerCase().includes("event not found")) {
            // Event is not (yet) joinable or has been removed — skip it and retry next run.
            console.log(`Event "${event.code}" (reward=${event.rewardPerKwhInOctoPoints} OctoPoints/kWh) not joinable (${msg}) — skipping, will retry next run.`);
          } else {
            // Unexpected error — log with event context and continue to the next event.
            console.error(`Join failed for event "${event.code}" (id=${event.id}, reward=${event.rewardPerKwhInOctoPoints} OctoPoints/kWh): ${msg} — skipping to next event.`);
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Error in scheduled run: ${errorMessage}`);

      // Transient backend outages (e.g. 503 Service Unavailable) happen from
      // time to time — log them for observability but don't send an email alert.
      if (error instanceof BackendUnavailableError) {
        console.log(`Skipping email alert: backend temporarily unavailable (status ${error.status}).`);
        return;
      }

      await trySendEmail(
        {
          to: env.EMAIL_TO,
          from: env.EMAIL_FROM,
          subject: "❌ automator-octopus-energy: Error checking saving sessions",
          body: [
            "An error occurred while checking Octopus Energy saving sessions.",
            "",
            `Error: ${errorMessage}`,
            `Time: ${new Date().toISOString()}`,
          ].join("\n"),
        },
        env,
      );
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/trigger") {
      await this.scheduled?.({} as ScheduledEvent, env, {} as ExecutionContext);
      return new Response("Triggered. Check logs.", { status: 200 });
    }

    return new Response("automator-octopus-energy is running.", { status: 200 });
  },
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/London" });
}
