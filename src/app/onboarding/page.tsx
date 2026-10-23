import { redirect } from "next/navigation";

// Setup now happens in conversation with HARU on the home screen.
export default function OnboardingPage() {
  redirect("/");
}
