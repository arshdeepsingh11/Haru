import { route } from "@/lib/server/http";
import { AppError } from "@/lib/server/errors";
import { scanSchedule } from "@/lib/server/services/scan";

export const runtime = "nodejs";
export const maxDuration = 60;

/** POST multipart/form-data with `photo`: returns the shifts HARU read, for the user to review. Saves nothing. */
export const POST = route(async (ctx, req) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new AppError("Send the photo as form data.");
  }
  const file = form.get("photo");
  if (!(file instanceof File)) throw new AppError("No photo received.");
  return scanSchedule(ctx, file);
});
