import { db } from "@/lib/db";

export type AiTokenLimitPeriod = "hour" | "day" | "month";

export interface AiTokenLimits {
  hour: number | null;
  day: number | null;
  month: number | null;
}

export interface AiTokenUsageSummary {
  hour: number;
  day: number;
  month: number;
}

export interface AiTokenUsageStatus {
  limits: AiTokenLimits;
  usage: AiTokenUsageSummary;
}

export class TokenLimitError extends Error {
  code = "limit_exceeded" as const;
  period: AiTokenLimitPeriod;
  limit: number;
  used: number;

  constructor(period: AiTokenLimitPeriod, limit: number, used: number) {
    const labels: Record<AiTokenLimitPeriod, string> = {
      hour: "hourly",
      day: "daily",
      month: "monthly",
    };
    super(
      `${labels[period].charAt(0).toUpperCase()}${labels[period].slice(1)} AI token limit reached — ${used.toLocaleString()} of ${limit.toLocaleString()} tokens used. Try again later or contact an admin.`
    );
    this.name = "TokenLimitError";
    this.period = period;
    this.limit = limit;
    this.used = used;
  }
}

function usageWindows(now = new Date()) {
  return {
    hour: new Date(now.getTime() - 60 * 60 * 1000),
    day: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    month: new Date(now.getFullYear(), now.getMonth(), 1),
  };
}

export async function getUserAiTokenLimits(userId: string): Promise<AiTokenLimits> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      aiTokenLimitHour: true,
      aiTokenLimitDay: true,
      aiTokenLimitMonth: true,
    },
  });

  return {
    hour: user?.aiTokenLimitHour ?? null,
    day: user?.aiTokenLimitDay ?? null,
    month: user?.aiTokenLimitMonth ?? null,
  };
}

export async function getUserTokenUsageSummary(
  userId: string,
  now = new Date()
): Promise<AiTokenUsageSummary> {
  const windows = usageWindows(now);

  const [hour, day, month] = await Promise.all([
    db.aiTokenUsage.aggregate({
      where: { userId, createdAt: { gte: windows.hour } },
      _sum: { totalTokens: true },
    }),
    db.aiTokenUsage.aggregate({
      where: { userId, createdAt: { gte: windows.day } },
      _sum: { totalTokens: true },
    }),
    db.aiTokenUsage.aggregate({
      where: { userId, createdAt: { gte: windows.month } },
      _sum: { totalTokens: true },
    }),
  ]);

  return {
    hour: hour._sum.totalTokens ?? 0,
    day: day._sum.totalTokens ?? 0,
    month: month._sum.totalTokens ?? 0,
  };
}

export async function getBulkTokenUsageSummaries(
  userIds: string[],
  now = new Date()
): Promise<Record<string, AiTokenUsageSummary>> {
  if (userIds.length === 0) return {};

  const windows = usageWindows(now);
  const empty = (): AiTokenUsageSummary => ({ hour: 0, day: 0, month: 0 });
  const map = Object.fromEntries(userIds.map((id) => [id, empty()]));

  const merge = (
    rows: { userId: string; _sum: { totalTokens: number | null } }[],
    key: keyof AiTokenUsageSummary
  ) => {
    for (const row of rows) {
      if (!map[row.userId]) map[row.userId] = empty();
      map[row.userId][key] = row._sum.totalTokens ?? 0;
    }
  };

  const [hourRows, dayRows, monthRows] = await Promise.all([
    db.aiTokenUsage.groupBy({
      by: ["userId"],
      where: { userId: { in: userIds }, createdAt: { gte: windows.hour } },
      _sum: { totalTokens: true },
    }),
    db.aiTokenUsage.groupBy({
      by: ["userId"],
      where: { userId: { in: userIds }, createdAt: { gte: windows.day } },
      _sum: { totalTokens: true },
    }),
    db.aiTokenUsage.groupBy({
      by: ["userId"],
      where: { userId: { in: userIds }, createdAt: { gte: windows.month } },
      _sum: { totalTokens: true },
    }),
  ]);

  merge(hourRows, "hour");
  merge(dayRows, "day");
  merge(monthRows, "month");

  return map;
}

export async function getUserTokenUsageStatus(userId: string): Promise<AiTokenUsageStatus> {
  const [limits, usage] = await Promise.all([
    getUserAiTokenLimits(userId),
    getUserTokenUsageSummary(userId),
  ]);
  return { limits, usage };
}

function checkLimit(
  period: AiTokenLimitPeriod,
  limit: number | null,
  used: number
): void {
  if (limit == null) return;
  if (used >= limit) {
    throw new TokenLimitError(period, limit, used);
  }
}

export async function assertUserTokenLimit(userId: string): Promise<void> {
  const [limits, usage] = await Promise.all([
    getUserAiTokenLimits(userId),
    getUserTokenUsageSummary(userId),
  ]);

  checkLimit("hour", limits.hour, usage.hour);
  checkLimit("day", limits.day, usage.day);
  checkLimit("month", limits.month, usage.month);
}

export async function recordAiTokenUsage(
  userId: string,
  tokens: number,
  details?: { promptTokens?: number; completionTokens?: number }
): Promise<void> {
  if (!Number.isFinite(tokens) || tokens <= 0) return;

  await db.aiTokenUsage.create({
    data: {
      userId,
      totalTokens: Math.round(tokens),
      promptTokens: details?.promptTokens,
      completionTokens: details?.completionTokens,
    },
  });
}

export function parseOptionalTokenLimit(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Token limits must be non-negative integers");
  }
  return parsed;
}
