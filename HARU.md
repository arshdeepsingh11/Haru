<div align="center">

# $ HARU

### Work for Haru.

**An AI money coach that thinks in shifts, not salaries.**

`Next.js 16` · `React 19` · `Supabase Postgres` · `Gemini / Claude` · `Web Push` · `PWA`

</div>

---

## What we built

HARU is a personal work-and-money app for people who are paid by the hour, often at more than one job. You never type "I make $X a month". You tell HARU your **jobs, pay rates, schedules and pay calendars**, and it works out everything else:

- what every single shift is worth **after tax**
- which **paycheck** that money lands in, and how big that paycheck is so far
- how many **days sooner** each shift gets you to your goal
- what to pay off first, and **when you'll be debt-free**

Then it stays with you. An hour before every shift it asks *"Are you going?"* and shows what you'll earn. After the shift it asks *"Did you finish?"* and logs every penny.

## Why

People who live shift-to-shift don't have a monthly income. They have a schedule that changes, two or three employers with different pay days, overtime one week and a cancelled shift the next. Budget apps built around a salary don't fit, so they get abandoned.

Skipping a shift feels free in the moment. HARU makes the cost visible: **"$123.50 you won't earn. Your debt-free date moves 4 days later."** Going feels like progress: **"Let's go. This shift is +$123.50 and puts you 4 days closer."**

The goal is motivation backed by real arithmetic, never guesses.

## Who it's for

| | |
|---|---|
| 👷 **Hourly workers** | Security, retail, food service, warehouse, care work |
| 🔀 **Multi-job people** | Two or three jobs, each with its own pay rate and pay calendar |
| 🎯 **People with a target** | A credit card to clear, a loan to repay, an emergency fund to build, all by a date |
| 📱 **Phone-first users** | Installed as an app on the home screen, with notifications that have buttons |

## How it works

### 1. The interview (no forms)

HARU asks one question at a time, like a conversation:

```mermaid
flowchart LR
    A([Name]) --> B([Goals<br/>debts · savings · dates])
    B --> C([How many jobs?])
    C --> D([Each job<br/>employer · $/h])
    D --> E([Pay calendar<br/>weekly · biweekly ·<br/>15th & 30th · monthly])
    E --> F([Usual schedule<br/>days · start · end])
    F --> D
    F --> G([Expenses<br/>rent · phone · groceries…])
    G --> H([Bank balance])
    H --> I([Tax 5%])
    I --> J([Notifications])
    J --> K{{Dashboard built}}
    style K fill:#7c3aed,color:#fff,stroke:#7c3aed
```

It never asks for monthly income. Income is calculated as **jobs × rates × schedule**.

### 2. The shift loop

```mermaid
sequenceDiagram
    autonumber
    participant S as Scheduler (every minute)
    participant P as Your phone
    participant H as HARU
    S->>P: 1 hour before: "Go and earn $123.50 after tax.<br/>It goes into your Oct 30 paycheck. Are you going?"
    alt I'm going
        P->>H: going ✓
        H-->>P: "Let's go. +$123.50, 4 days closer."
    else Can't make it
        P->>H: not going
        H-->>P: "$123.50 you won't earn." (shift marked missed)
    end
    S->>P: 10 min after it ends: "Did you finish?"
    alt Full shift
        P->>H: full
    else Fewer hours
        P->>H: 5.5 h
    end
    H-->>P: "Logged 5.5 h: +$104.50 after tax.<br/>Your Oct 30 paycheck is now about $612."
    H->>H: remember behaviour (shift_events)
```

The notification buttons work **without opening the app**: the service worker posts the answer and shows the result.

### 3. Paycheck maths: your real calendar

Pay periods and pay days are set per job. Example: periods **10th–24th** and **25th–9th**, paid on the **15th** and **30th**:

```mermaid
gantt
    title Work period → payday (twice a month, paid 15th & 30th)
    dateFormat YYYY-MM-DD
    axisFormat %b %d
    section Period A
    Work Oct 10 – Oct 24      :a1, 2026-10-10, 15d
    Paid Oct 30               :milestone, 2026-10-30, 0d
    section Period B
    Work Oct 25 – Nov 9       :b1, 2026-10-25, 16d
    Paid Nov 15               :milestone, 2026-11-15, 0d
```

Supported: **weekly**, **every 2 weeks** (anchored to your next payday and the gap after the period ends), **twice a month** (any two pay days, any two period start days; `31` means the last day of the month), and **monthly**. Weekend paydays follow the job's rule.

### 4. Take-home, every time

```
gross       = hours × rate          (minus unpaid break)
tax set-aside = gross × 5%          (configurable)
take-home   = gross − tax set-aside
```

All money is stored as **integer cents**. Nothing is rounded twice, and floating-point maths never touches a balance.

### 5. The payoff plan

```mermaid
flowchart TD
    I[Projected monthly take-home<br/>from your schedule] --> S[Surplus]
    B[Bills & expenses] --> S
    S --> M[Pay every minimum]
    M --> X[Extra goes to the<br/>highest-interest debt]
    X --> R[When it's cleared, its minimum<br/>rolls into the next one]
    R --> G[After the debts: your savings goals]
    G --> D{{Debt-free date ·<br/>goal dates · days closer per shift}}
    style D fill:#7c3aed,color:#fff,stroke:#7c3aed
```

`daysCloser = shift take-home ÷ (monthly surplus ÷ 30.44)`: this is the "4 days closer" number on every shift card.

### 6. An AI that does things

Ask in plain words: *"I picked up an extra shift at the restaurant Saturday 5 to 11"*, *"I didn't go today"*, *"how long until my Visa is gone?"*. The assistant has **44 typed tools** (shifts, attendance, checkout, paychecks, bills, debts, goals, payoff plan, reminders and more).

- Every tool input is validated with Zod before anything touches the database.
- Write actions return an **undo**, and risky actions ask to **confirm** first.
- It sees a live snapshot of *today's picture* (next shift, paycheck so far, streak, plan) so answers are specific and short.
- It **learns from behaviour**: every going, skip, full or partial shift is stored, and patterns such as "you've missed 3 of the last 4 Saturdays" become gentle observations.
- Works with **Google Gemini** (free tier) or **Anthropic Claude**. If the provider fails, the exact reason is shown (bad key, quota, wrong model).

## Architecture

```mermaid
flowchart LR
    subgraph Phone["📱 Phone / browser (PWA)"]
        UI[Glass UI<br/>Dashboard · Schedule · Chat]
        SW[Service worker<br/>push + action buttons]
    end
    subgraph Vercel["▲ Vercel"]
        RSC[Next.js 16<br/>server components + actions]
        API[/api: shifts · push · chat · cron/]
        AI[AI agent<br/>44 tools · confirm · undo]
        DOM[Domain maths<br/>payroll · payoff · reminders]
    end
    subgraph Supa["Supabase"]
        AUTH[Auth]
        PG[(Postgres<br/>RLS on · cents · FKs)]
        CRON[pg_cron every minute<br/>→ pg_net]
    end
    LLM[(Gemini / Claude)]
    PUSH[(Web Push<br/>VAPID)]

    UI <--> RSC
    SW <--> API
    RSC --> DOM
    API --> DOM
    RSC --> AI --> LLM
    AI --> DOM
    DOM <--> PG
    RSC --> AUTH
    CRON --> API
    API --> PUSH --> SW
```

**Reliable notifications.** The scheduler plans reminders into a table with **dedupe keys**, claims them with `FOR UPDATE SKIP LOCKED`, retries failures, and re-checks before sending, so a cancelled or skipped shift never pings you. The device confirms delivery back to the server.

## By the numbers

```mermaid
xychart-beta
    title "Verified test coverage by suite"
    x-axis ["Domain maths", "Gemini adapter", "Tool schemas", "Integration (real Postgres)"]
    y-axis "Passing tests" 0 --> 30
    bar [23, 5, 8, 26]
```

| Metric | Value |
|---|---|
| AI tools | **44**, all schema-validated |
| Pay calendars | weekly · biweekly · twice-monthly (custom days) · monthly |
| Money precision | integer cents end to end |
| Reminder lead | 60 min before each shift, check-in 10 min after |
| Default tax set-aside | 5%, editable |
| Notification cadence | every minute (pg_cron) |
| Data isolation | composite foreign keys per user · RLS with no public access |

## Design

White and violet **glassmorphism**: frosted panels (`backdrop-blur`) floating over soft violet light, a violet gradient hero for the next shift, gradient area charts for take-home, and a **$** mark as the logo. Sora for type. Built mobile-first and installable as an app.

## Running it

```bash
npm install
cp .env.example .env.local     # Supabase URL/keys, DATABASE_URL, GEMINI_API_KEY, VAPID keys
npm run db:migrate             # applies 0001_init + 0002_shift_loop
npm run dev
```

Tests: `npm test` (domain, Gemini, tool schemas) · `npm run test:integration` against a throwaway database.

---

<div align="center"><b>$ HARU</b> · Work for Haru.</div>
