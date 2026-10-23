import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/server/context";
import { errorResponse } from "@/lib/server/http";
import { sql } from "@/lib/server/db";
import { generateReport } from "@/lib/server/services/reports";
import { reportToCsv } from "@/lib/domain/report";
import { RangeInput } from "@/lib/validation";
import { AppError } from "@/lib/server/errors";

export const runtime = "nodejs";

const TABLES = [
  "user_preferences", "jobs", "job_wages", "shifts", "work_opportunities", "paychecks", "accounts", "transactions",
  "bills", "bill_payments", "debts", "savings_goals", "goal_contributions", "reminders", "ai_conversations",
  "ai_messages", "ai_actions", "behavior_observations", "dashboard_preferences", "activity_log",
] as const;

/** ?type=report&period=this_week → CSV.  ?type=all → full JSON export of the user's data. */
export async function GET(req: Request) {
  try {
    const ctx = await requireCtx();
    const p = new URL(req.url).searchParams;
    if (p.get("type") === "all") {
      const out: Record<string, unknown> = { exported_at: new Date().toISOString(), note: "Money values are integer cents." };
      for (const t of TABLES) out[t] = await sql`select * from ${sql(t)} where user_id = ${ctx.userId}`;
      return new NextResponse(JSON.stringify(out, null, 2), {
        headers: { "content-type": "application/json", "content-disposition": `attachment; filename="haru-export-${ctx.today}.json"` },
      });
    }
    const r = RangeInput.safeParse({ period: p.get("period") ?? "this_month", start: p.get("start") ?? undefined, end: p.get("end") ?? undefined });
    if (!r.success) throw new AppError("Invalid report period.");
    const report = await generateReport(ctx, r.data.period, r.data);
    return new NextResponse(reportToCsv(report), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="haru-report-${report.range.start}-${report.range.end}.csv"` },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
