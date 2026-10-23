import { route } from "@/lib/server/http";
import { planData } from "@/lib/server/invest/planning";

export const runtime = "nodejs";
export const maxDuration = 30;

/** GET → budget inputs + CAD→INR record for the SIP and send-home planners. */
export const GET = route(async (ctx) => planData(ctx));
