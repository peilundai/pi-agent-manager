import { timingSafeEqual } from "node:crypto";
import type { SessionStatus } from "../shared/model";

const MAX_ID_LENGTH = 200;
const MAX_PATH_LENGTH = 16_384;
const MAX_NAME_LENGTH = 512;

export interface StatusReport {
  version: 1;
  token: string;
  tabId: string;
  sequence: number;
  status: SessionStatus;
  timestamp: number;
  sessionId?: string;
  sessionPath?: string;
  name?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isBoundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0);
}

function isStatus(value: unknown): value is SessionStatus {
  return (
    value === "starting" ||
    value === "working" ||
    value === "waiting" ||
    value === "stopped" ||
    value === "failed"
  );
}

function tokenMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isOptionalString(value: unknown, maximum: number): value is string | undefined {
  return value === undefined || isBoundedString(value, maximum);
}

function isOptionalName(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || isBoundedString(value, MAX_NAME_LENGTH);
}

export class StatusReportGate {
  private readonly latestSequence = new Map<string, number>();

  constructor(private readonly expectedToken: string) {
    if (!expectedToken) throw new Error("Status token must not be empty.");
  }

  accept(value: unknown): StatusReport | undefined {
    const report = asRecord(value);
    const sequence = report?.sequence;
    if (
      !report ||
      report.version !== 1 ||
      !tokenMatches(report.token, this.expectedToken) ||
      !isBoundedString(report.tabId, MAX_ID_LENGTH) ||
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      !isStatus(report.status) ||
      typeof report.timestamp !== "number" ||
      !Number.isFinite(report.timestamp) ||
      report.timestamp < 0 ||
      !isOptionalString(report.sessionId, MAX_ID_LENGTH) ||
      !isOptionalString(report.sessionPath, MAX_PATH_LENGTH) ||
      !isOptionalName(report.name)
    ) {
      return undefined;
    }

    const latest = this.latestSequence.get(report.tabId) ?? -1;
    if (sequence <= latest) return undefined;
    this.latestSequence.set(report.tabId, sequence);
    return report as unknown as StatusReport;
  }
}
