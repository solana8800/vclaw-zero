import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveStateDir as resolvePluginStateDir } from "openclaw/plugin-sdk/state-paths";
import { loadOutboundMediaFromUrl } from "../runtime-api.js";
import { normalizeZaloReactionIcon } from "./reaction.js";
import type {
  ZaloAuthStatus,
  ZaloEventMessage,
  ZaloGroupContext,
  ZaloGroup,
  ZaloGroupMember,
  ZaloInboundMessage,
  ZaloSendOptions,
  ZaloSendResult,
  ZcaFriend,
  ZcaUserInfo,
} from "./types.js";
import { normalizeZaloInboundTextContent } from "./zalo-inbound-text.js";
import {
  TextStyle,
  type API,
  type Credentials,
  type GroupInfo,
  type LoginQRCallbackEvent,
  type Message,
  type User,
  createZalo,
} from "./zca-client.js";
import { LoginQRCallbackEventType, ThreadType } from "./zca-constants.js";

const API_LOGIN_TIMEOUT_MS = 20_000;
const QR_LOGIN_TTL_MS = 3 * 60_000;
const DEFAULT_QR_START_TIMEOUT_MS = 30_000;
const DEFAULT_QR_WAIT_TIMEOUT_MS = 120_000;
const GROUP_INFO_CHUNK_SIZE = 80;
const GROUP_CONTEXT_CACHE_TTL_MS = 5 * 60_000;
const GROUP_CONTEXT_CACHE_MAX_ENTRIES = 500;
const LISTENER_WATCHDOG_INTERVAL_MS = 30_000;
const LISTENER_WATCHDOG_MAX_GAP_MS = 35_000;
const LISTENER_OLD_MESSAGES_SYNC_INTERVAL_MS = 15_000;
const LISTENER_DEDUPE_MAX_ENTRIES = 2_000;
const ZALO_CHANNEL_THREAD_TYPE = 2;

const apiByProfile = new Map<string, API>();
const apiInitByProfile = new Map<string, Promise<API>>();

type ActiveZaloQrLogin = {
  id: string;
  profile: string;
  startedAt: number;
  qrDataUrl?: string;
  connected: boolean;
  error?: string;
  abort?: () => void;
  waitPromise: Promise<void>;
};

const activeQrLogins = new Map<string, ActiveZaloQrLogin>();

type ActiveZaloListener = {
  profile: string;
  accountId: string;
  stop: () => void;
};

type ZaloWsFrameHeader = {
  version: number;
  cmd: number;
  subCmd: number;
  bytes: number;
};

type ZaloListenerWithRawSocket = {
  ws?: {
    on?: (event: "message", callback: (data: unknown) => void) => unknown;
    off?: (event: "message", callback: (data: unknown) => void) => unknown;
    removeListener?: (event: "message", callback: (data: unknown) => void) => unknown;
  } | null;
  cipherKey?: string;
};

type ZcaJsUtilsRuntime = {
  decodeEventData: (parsed: Record<string, unknown>, cipherKey?: string) => Promise<unknown>;
};

type DecodedZaloWsMessageBatch = {
  source: "decoded_msgs" | "decoded_groupMsgs" | "decoded_pageMsgs";
  messages: Message[];
};

type ExtractDecodedZaloWsMessageBatchesOptions = {
  pageMessagesOnly?: boolean;
};

const requireFromHere = createRequire(import.meta.url);
let zcaJsUtilsRuntimePromise: Promise<ZcaJsUtilsRuntime> | null = null;

const activeListeners = new Map<string, ActiveZaloListener>();
const groupContextCache = new Map<string, { value: ZaloGroupContext; expiresAt: number }>();

type AccountInfoResponse = Awaited<ReturnType<API["fetchAccountInfo"]>>;

type ApiTypingCapability = {
  sendTypingEvent: (
    threadId: string,
    type?: (typeof ThreadType)[keyof typeof ThreadType],
  ) => Promise<unknown>;
};

type StoredZaloCredentials = {
  imei: string;
  cookie: Credentials["cookie"];
  userAgent: string;
  language?: string;
  createdAt: string;
  lastUsedAt?: string;
};

function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolvePluginStateDir(env, os.homedir);
}

function resolveCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "credentials", "zalouser");
}

function credentialsFilename(profile: string): string {
  const trimmed = profile.trim().toLowerCase();
  if (!trimmed || trimmed === "default") {
    return "credentials.json";
  }
  return `credentials-${encodeURIComponent(trimmed)}.json`;
}

function resolveCredentialsPath(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveCredentialsDir(env), credentialsFilename(profile));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(label));
    }, timeoutMs);
    void promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeProfile(profile?: string | null): string {
  const trimmed = profile?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "default";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function loadZcaJsUtilsRuntime(): Promise<ZcaJsUtilsRuntime> {
  zcaJsUtilsRuntimePromise ??= (async () => {
    const indexPath = requireFromHere.resolve("zca-js");
    const indexDir = path.dirname(indexPath);
    const distDir =
      path.basename(indexPath) === "index.cjs" && path.basename(indexDir) === "cjs"
        ? path.dirname(indexDir)
        : indexDir;
    const utilsUrl = pathToFileURL(path.join(distDir, "utils.js")).href;
    return (await import(utilsUrl)) as unknown as ZcaJsUtilsRuntime;
  })();
  return await zcaJsUtilsRuntimePromise;
}

function stringifyForZalouserLog(value: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") {
      return item.toString();
    }
    if (item && typeof item === "object") {
      if (seen.has(item)) {
        return "[Circular]";
      }
      seen.add(item);
    }
    return item;
  });
}

function truncateForZalouserLog(value: string, maxLength = 2_400): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...<truncated ${value.length - maxLength} chars>`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)))
    : [];
}

function bufferFromWsFrameData(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function decodeZaloWsFrameHeader(data: unknown): ZaloWsFrameHeader | null {
  const buffer = bufferFromWsFrameData(data);
  if (!buffer || buffer.byteLength < 4) {
    return null;
  }
  return {
    version: buffer[0] ?? 0,
    cmd: buffer.readUInt16LE(1),
    subCmd: buffer[3] ?? 0,
    bytes: buffer.byteLength,
  };
}

function describeKnownZaloWsCommand(cmd: number, subCmd: number): string {
  if (cmd === 1 && subCmd === 1) {
    return "cipher_key";
  }
  if (cmd === 501 && subCmd === 0) {
    return "user_message";
  }
  if (cmd === 521 && subCmd === 0) {
    return "group_message";
  }
  if (cmd === 510 && subCmd === 1) {
    return "old_user_messages";
  }
  if (cmd === 511 && subCmd === 1) {
    return "old_group_messages";
  }
  if (cmd === 601 && subCmd === 0) {
    return "control";
  }
  if (cmd === 602 && subCmd === 0) {
    return "typing";
  }
  if (cmd === 610 || cmd === 611 || cmd === 612) {
    return "reaction";
  }
  if (cmd === 502 || cmd === 522) {
    return "delivery_seen";
  }
  if (cmd === 3000) {
    return "duplicate_connection";
  }
  return "unknown";
}

function shouldDecodeZaloWsFrameForPageMessages(header: ZaloWsFrameHeader): boolean {
  if (header.version !== 1) {
    return false;
  }
  if (header.cmd === 501 && header.subCmd === 0) {
    return true;
  }
  if ((header.cmd === 510 || header.cmd === 513 || header.cmd === 515) && header.subCmd <= 1) {
    return true;
  }
  return false;
}

async function logDecodedZaloWsFrame(
  data: unknown,
  listener: ZaloListenerWithRawSocket,
  profile: string,
  header: ZaloWsFrameHeader,
  options?: ExtractDecodedZaloWsMessageBatchesOptions,
  onDecodedMessageBatch?: (batch: DecodedZaloWsMessageBatch, header: ZaloWsFrameHeader) => void,
): Promise<void> {
  const buffer = bufferFromWsFrameData(data);
  if (!buffer || buffer.byteLength <= 4) {
    return;
  }
  const jsonText = new TextDecoder("utf-8").decode(buffer.subarray(4));
  if (!jsonText.trim()) {
    return;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText) as Record<string, unknown>;
  } catch (error) {
    if (shouldLogZalouserRawInbound()) {
      writeZalouserInboundDiag(
        `[zalouser][ws-frame-decode-error] profile=${profile} cmd=${header.cmd} subCmd=${header.subCmd} parse=${toErrorMessage(
          error,
        )}`,
      );
    }
    return;
  }
  try {
    const { decodeEventData } = await loadZcaJsUtilsRuntime();
    const decoded = await decodeEventData(parsed, listener.cipherKey);
    if (shouldLogZalouserRawInbound()) {
      writeZalouserInboundDiag(
        `[zalouser][ws-frame-decoded] profile=${profile} cmd=${header.cmd} subCmd=${header.subCmd} data=${truncateForZalouserLog(
          stringifyForZalouserLog(decoded) ?? "null",
        )}`,
      );
    }
    for (const batch of extractDecodedZaloWsMessageBatches(decoded, options)) {
      onDecodedMessageBatch?.(batch, header);
    }
  } catch (error) {
    if (shouldLogZalouserRawInbound()) {
      writeZalouserInboundDiag(
        `[zalouser][ws-frame-decode-error] profile=${profile} cmd=${header.cmd} subCmd=${header.subCmd} keys=${Object.keys(
          parsed,
        )
          .slice(0, 12)
          .join(",")} error=${toErrorMessage(error)}`,
      );
    }
  }
}

function decodedMessageRecordToMessage(
  data: Record<string, unknown>,
  type: number,
): Message | null {
  const threadId =
    type === ThreadType.Group
      ? pickFirstNumberId(data, ["idTo", "threadId"])
      : type === ThreadType.User
        ? pickFirstNumberId(data, ["uidFrom", "fromUid", "senderUid", "senderId", "idTo"])
        : pickFirstNonZeroNumberId(data, [
            "threadId",
            "pageId",
            "channelId",
            "oaId",
            "uidFrom",
            "fromUid",
            "senderUid",
            "senderId",
            "idTo",
          ]);
  if (!threadId) {
    return null;
  }
  return {
    type,
    threadId,
    isSelf: false,
    data,
  };
}

function extractDecodedZaloWsMessageBatches(
  decoded: unknown,
  options?: ExtractDecodedZaloWsMessageBatchesOptions,
): DecodedZaloWsMessageBatch[] {
  const root = asRecord(decoded);
  const data = asRecord(root?.data);
  if (!data) {
    return [];
  }
  const batches: DecodedZaloWsMessageBatch[] = [];
  if (!options?.pageMessagesOnly) {
    const userMessages = asRecordArray(data.msgs)
      .map((item) => decodedMessageRecordToMessage(item, ThreadType.User))
      .filter((item): item is Message => item !== null);
    if (userMessages.length > 0) {
      batches.push({ source: "decoded_msgs", messages: userMessages });
    }
    const groupMessages = asRecordArray(data.groupMsgs)
      .map((item) => decodedMessageRecordToMessage(item, ThreadType.Group))
      .filter((item): item is Message => item !== null);
    if (groupMessages.length > 0) {
      batches.push({ source: "decoded_groupMsgs", messages: groupMessages });
    }
  }
  const pageMessages = asRecordArray(data.pageMsgs)
    .map((item) => decodedMessageRecordToMessage(item, ZALO_CHANNEL_THREAD_TYPE))
    .filter((item): item is Message => item !== null);
  if (pageMessages.length > 0) {
    batches.push({ source: "decoded_pageMsgs", messages: pageMessages });
  }
  return batches;
}

function installZaloWsFrameTap(
  listener: unknown,
  profile: string,
  onDecodedMessageBatch?: (batch: DecodedZaloWsMessageBatch, header: ZaloWsFrameHeader) => void,
): () => void {
  const rawListener = listener as ZaloListenerWithRawSocket;
  const socket = rawListener.ws;
  if (!socket || typeof socket.on !== "function") {
    if (shouldLogZalouserRawInbound()) {
      writeZalouserInboundDiag(
        `[zalouser][ws-frame-tap] profile=${profile} không truy cập được raw WebSocket từ zca-js`,
      );
    }
    return () => {};
  }
  const onRawFrame = (data: unknown) => {
    const header = decodeZaloWsFrameHeader(data);
    if (!header) {
      if (shouldLogZalouserRawInbound()) {
        writeZalouserInboundDiag(`[zalouser][ws-frame] profile=${profile} unreadable`);
      }
      return;
    }
    if (shouldLogZalouserRawInbound()) {
      writeZalouserInboundDiag(
        `[zalouser][ws-frame] profile=${profile} version=${header.version} cmd=${header.cmd} subCmd=${header.subCmd} bytes=${header.bytes} known=${describeKnownZaloWsCommand(
          header.cmd,
          header.subCmd,
        )}`,
      );
    }
    const known = describeKnownZaloWsCommand(header.cmd, header.subCmd);
    if (known === "unknown" || shouldDecodeZaloWsFrameForPageMessages(header)) {
      void logDecodedZaloWsFrame(
        data,
        rawListener,
        profile,
        header,
        known === "unknown" ? undefined : { pageMessagesOnly: true },
        onDecodedMessageBatch,
      );
    }
  };
  socket.on("message", onRawFrame);
  return () => {
    if (typeof socket.off === "function") {
      socket.off("message", onRawFrame);
      return;
    }
    socket.removeListener?.("message", onRawFrame);
  };
}

function clampTextStyles(
  text: string,
  styles?: ZaloSendOptions["textStyles"],
): ZaloSendOptions["textStyles"] {
  if (!styles || styles.length === 0) {
    return undefined;
  }
  const maxLength = text.length;
  const clamped = styles
    .map((style) => {
      const start = Math.max(0, Math.min(style.start, maxLength));
      const end = Math.min(style.start + style.len, maxLength);
      if (end <= start) {
        return null;
      }
      if (style.st === TextStyle.Indent) {
        return {
          start,
          len: end - start,
          st: style.st,
          indentSize: style.indentSize,
        };
      }
      return {
        start,
        len: end - start,
        st: style.st,
      };
    })
    .filter((style): style is NonNullable<typeof style> => style !== null);
  return clamped.length > 0 ? clamped : undefined;
}

function toNumberId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed.replace(/_\d+$/, "");
    }
  }
  return "";
}

function pickFirstNumberId(data: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const v = toNumberId(data[key]);
    if (v) {
      return v;
    }
  }
  return "";
}

function pickFirstNonZeroNumberId(data: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const v = toNumberId(data[key]);
    if (v && v !== "0") {
      return v;
    }
  }
  return "";
}

function shouldLogZalouserRawInbound(): boolean {
  const v = process.env.OPENCLAW_ZALOUSER_LOG_RAW_INBOUND?.trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

function resolveOldMessagesSyncIntervalMs(): number {
  const raw = process.env.OPENCLAW_ZALOUSER_OLD_MESSAGES_SYNC_MS?.trim();
  if (!raw) {
    return LISTENER_OLD_MESSAGES_SYNC_INTERVAL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return LISTENER_OLD_MESSAGES_SYNC_INTERVAL_MS;
  }
  return parsed === 0 ? 0 : Math.max(parsed, 5_000);
}

/** Ghi thẳng stderr (không qua console đã patch) — luôn vào file log của `nohup … >log 2>&1`. */
function writeZalouserInboundDiag(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // ignore
  }
}

/** Gợi ý vì sao OA/Page không map được (thiếu id trong payload). */
function explainToInboundNull(message: Message, ownUserId?: string): string {
  const data = message.data;
  const isGroup = message.type === ThreadType.Group;
  const isChannel = !isGroup && message.type !== ThreadType.User;
  const wrap = message as Message & { threadId?: unknown };
  const wrapperThreadId = toNumberId(wrap.threadId);
  const senderId = pickFirstNumberId(data, [
    "uidFrom",
    "fromUid",
    "senderUid",
    "senderId",
    "srcUid",
    "userId",
    "pageId",
    "fromPageId",
    "oaId",
    "fromId",
    "src",
  ]);
  const threadId = isGroup
    ? pickFirstNumberId(data, ["idTo", "threadId"]) || wrapperThreadId
    : isChannel
      ? pickFirstNumberId(data, ["idTo", "threadId", "pageId", "channelId", "oaId"]) ||
        wrapperThreadId
      : wrapperThreadId ||
        pickFirstNumberId(data, ["uidFrom", "fromUid", "senderUid", "senderId"]) ||
        toNumberId(data.uidFrom) ||
        toNumberId(data.idTo);
  const keys =
    data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data).slice(0, 40) : [];
  return JSON.stringify({
    isGroup,
    isChannel,
    type: message.type,
    wrapperThreadId: wrapperThreadId || null,
    computedThreadId: threadId || null,
    computedSenderId: senderId || null,
    rawUidFrom: data.uidFrom,
    rawIdTo: data.idTo,
    rawPageId: data.pageId,
    rawOaId: data.oaId,
    msgType: data.msgType,
    ownUserId: ownUserId ?? null,
    dataKeys: keys,
  });
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return "";
}

function normalizeAccountInfoUser(info: AccountInfoResponse): User | null {
  if (!info || typeof info !== "object") {
    return null;
  }
  if ("profile" in info) {
    const profile = (info as { profile?: unknown }).profile;
    if (profile && typeof profile === "object") {
      return profile as User;
    }
    return null;
  }
  return info;
}

function toInteger(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  const parsed = Number.parseInt(typeof value === "string" ? value : "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function normalizeMessageContent(content: unknown): string {
  return normalizeZaloInboundTextContent(content);
}

function resolveInboundTimestamp(rawTs: unknown): number {
  if (typeof rawTs === "number" && Number.isFinite(rawTs)) {
    return rawTs > 1_000_000_000_000 ? rawTs : rawTs * 1000;
  }
  const parsed = Number.parseInt(typeof rawTs === "string" ? rawTs : "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Date.now();
  }
  return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
}

function extractMentionIds(rawMentions: unknown): string[] {
  if (!Array.isArray(rawMentions)) {
    return [];
  }
  const sink = new Set<string>();
  for (const entry of rawMentions) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as { uid?: unknown };
    const id = toNumberId(record.uid);
    if (id) {
      sink.add(id);
    }
  }
  return Array.from(sink);
}

type MentionSpan = {
  start: number;
  end: number;
};

function toNonNegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized >= 0 ? normalized : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed >= 0 ? parsed : null;
    }
  }
  return null;
}

function extractOwnMentionSpans(
  rawMentions: unknown,
  ownUserId: string,
  contentLength: number,
): MentionSpan[] {
  if (!Array.isArray(rawMentions) || !ownUserId || contentLength <= 0) {
    return [];
  }
  const spans: MentionSpan[] = [];
  for (const entry of rawMentions) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as {
      uid?: unknown;
      pos?: unknown;
      start?: unknown;
      offset?: unknown;
      len?: unknown;
      length?: unknown;
    };
    const uid = toNumberId(record.uid);
    if (!uid || uid !== ownUserId) {
      continue;
    }
    const startRaw = toNonNegativeInteger(record.pos ?? record.start ?? record.offset);
    const lengthRaw = toNonNegativeInteger(record.len ?? record.length);
    if (startRaw === null || lengthRaw === null || lengthRaw <= 0) {
      continue;
    }
    const start = Math.min(startRaw, contentLength);
    const end = Math.min(start + lengthRaw, contentLength);
    if (end <= start) {
      continue;
    }
    spans.push({ start, end });
  }
  if (spans.length <= 1) {
    return spans;
  }
  spans.sort((a, b) => a.start - b.start);
  const merged: MentionSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (!last || span.start > last.end) {
      merged.push({ ...span });
      continue;
    }
    last.end = Math.max(last.end, span.end);
  }
  return merged;
}

function stripOwnMentionsForCommandBody(
  content: string,
  rawMentions: unknown,
  ownUserId: string,
): string {
  if (!content || !ownUserId) {
    return content;
  }
  const spans = extractOwnMentionSpans(rawMentions, ownUserId, content.length);
  if (spans.length === 0) {
    return stripLeadingAtMentionForCommand(content);
  }
  let cursor = 0;
  let output = "";
  for (const span of spans) {
    if (span.start > cursor) {
      output += content.slice(cursor, span.start);
    }
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < content.length) {
    output += content.slice(cursor);
  }
  return output.replace(/\s+/g, " ").trim();
}

function stripLeadingAtMentionForCommand(content: string): string {
  const fallbackMatch = content.match(/^\s*@[^\s]+(?:\s+|[:,-]\s*)([/!][\s\S]*)$/);
  if (!fallbackMatch) {
    return content;
  }
  return fallbackMatch[1].trim();
}

function resolveGroupNameFromMessageData(data: Record<string, unknown>): string | undefined {
  const candidates = [data.groupName, data.gName, data.idToName, data.threadName, data.roomName];
  for (const candidate of candidates) {
    const value = toStringValue(candidate);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function buildEventMessage(data: Record<string, unknown>): ZaloEventMessage | undefined {
  const msgId = toStringValue(data.msgId);
  const cliMsgId = toStringValue(data.cliMsgId);
  const uidFrom = toStringValue(data.uidFrom);
  const idTo = toStringValue(data.idTo);
  if (!msgId || !cliMsgId || !uidFrom || !idTo) {
    return undefined;
  }
  return {
    msgId,
    cliMsgId,
    uidFrom,
    idTo,
    msgType: toStringValue(data.msgType) || "webchat",
    st: toInteger(data.st, 0),
    at: toInteger(data.at, 0),
    cmd: toInteger(data.cmd, 0),
    ts: toStringValue(data.ts) || Date.now(),
  };
}

function resolveInboundDedupeKey(message: ZaloInboundMessage): string {
  const scope = message.isGroup ? "group" : message.isChannel ? "channel" : "user";
  const threadId = message.threadId.trim();
  const senderId = message.senderId.trim();
  const msgId = message.msgId?.trim();
  const cliMsgId = message.cliMsgId?.trim();
  if (msgId || cliMsgId) {
    return `${scope}:${threadId}:${senderId}:msg:${msgId ?? ""}:cli:${cliMsgId ?? ""}`;
  }
  return `${scope}:${threadId}:${senderId}:ts:${message.timestampMs}:body:${message.content.slice(
    0,
    200,
  )}`;
}

function rememberInboundDedupeKey(params: {
  key: string;
  seen: Set<string>;
  order: string[];
}): boolean {
  if (params.seen.has(params.key)) {
    return false;
  }
  params.seen.add(params.key);
  params.order.push(params.key);
  while (params.order.length > LISTENER_DEDUPE_MAX_ENTRIES) {
    const oldest = params.order.shift();
    if (oldest) {
      params.seen.delete(oldest);
    }
  }
  return true;
}

type ZaloDirectorySnapshot = {
  friends: Map<string, string>;
  groups: Map<string, string>;
};

function resolveConversationKind(params: {
  message: ZaloInboundMessage;
  historyType?: number;
  directory: ZaloDirectorySnapshot;
}): "friend" | "group" | "channel_candidate" | "nonfriend" | "unknown" {
  if (params.message.isGroup || params.historyType === ThreadType.Group) {
    return "group";
  }
  if (params.message.isChannel) {
    return "channel_candidate";
  }
  if (params.directory.friends.has(params.message.senderId)) {
    return "friend";
  }
  if (params.directory.groups.has(params.message.threadId)) {
    return "group";
  }
  if (params.message.senderId || params.message.threadId) {
    return "channel_candidate";
  }
  return "unknown";
}

function summarizeInboundMessageForLog(params: {
  message: ZaloInboundMessage;
  index?: number;
  historyType?: number;
  directory: ZaloDirectorySnapshot;
}): string {
  const preview = (params.message.content || params.message.commandContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  const historyType =
    params.historyType === ThreadType.Group
      ? "group"
      : params.historyType === ThreadType.User
        ? "user"
        : undefined;
  const conversationKind = resolveConversationKind({
    message: params.message,
    historyType: params.historyType,
    directory: params.directory,
  });
  return JSON.stringify({
    index: params.index ?? null,
    source: historyType ? "old_messages" : "realtime",
    historyType,
    conversationKind,
    scope: params.message.isGroup ? "group" : params.message.isChannel ? "channel" : "user",
    threadId: params.message.threadId,
    senderId: params.message.senderId,
    senderName: params.message.senderName ?? null,
    directoryName:
      params.directory.friends.get(params.message.senderId) ??
      params.directory.groups.get(params.message.threadId) ??
      null,
    msgType: params.message.msgType ?? null,
    msgId: params.message.msgId ?? null,
    cliMsgId: params.message.cliMsgId ?? null,
    timestampMs: params.message.timestampMs,
    preview,
  });
}

async function loadDirectorySnapshotForLogs(
  api: API,
  profile: string,
): Promise<ZaloDirectorySnapshot> {
  const [friendsResult, groupsResult] = await Promise.allSettled([
    api.getAllFriends(),
    api.getAllGroups(),
  ]);
  const friends = new Map<string, string>();
  if (friendsResult.status === "fulfilled") {
    for (const friend of friendsResult.value) {
      const id = toNumberId(friend.userId);
      if (id) {
        friends.set(id, friend.displayName || friend.zaloName || friend.username || id);
      }
    }
  } else if (shouldLogZalouserRawInbound()) {
    writeZalouserInboundDiag(
      `[zalouser][directory-error] profile=${profile} friends=${toErrorMessage(friendsResult.reason)}`,
    );
  }
  const groups = new Map<string, string>();
  if (groupsResult.status === "fulfilled") {
    const ids = Object.keys(groupsResult.value.gridVerMap ?? {});
    if (ids.length > 0) {
      const groupInfoResult = await Promise.allSettled([fetchGroupsByIds(api, ids)]);
      const groupInfo = groupInfoResult[0];
      if (groupInfo?.status === "fulfilled") {
        for (const [groupId, info] of groupInfo.value) {
          groups.set(groupId, info.name?.trim() || groupId);
        }
      } else if (groupInfo?.status === "rejected" && shouldLogZalouserRawInbound()) {
        writeZalouserInboundDiag(
          `[zalouser][directory-error] profile=${profile} groupInfo=${toErrorMessage(groupInfo.reason)}`,
        );
      }
    }
  } else if (shouldLogZalouserRawInbound()) {
    writeZalouserInboundDiag(
      `[zalouser][directory-error] profile=${profile} groups=${toErrorMessage(groupsResult.reason)}`,
    );
  }
  if (shouldLogZalouserRawInbound()) {
    writeZalouserInboundDiag(
      `[zalouser][directory] profile=${profile} friends=${friends.size} groups=${groups.size}`,
    );
  }
  return { friends, groups };
}

function isLikelyOwnDecodedPageMessage(message: Message, ownUserId?: string): boolean {
  if (message.type !== ZALO_CHANNEL_THREAD_TYPE) {
    return false;
  }
  const data = message.data;
  const senderId = pickFirstNumberId(data, [
    "uidFrom",
    "fromUid",
    "senderUid",
    "senderId",
    "srcUid",
    "userId",
  ]);
  const normalizedOwnUserId = toNumberId(ownUserId);
  return senderId === "0" || Boolean(normalizedOwnUserId && senderId === normalizedOwnUserId);
}

function extractSendMessageId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const payload = result as {
    msgId?: string | number;
    message?: { msgId?: string | number } | null;
    attachment?: Array<{ msgId?: string | number }>;
  };
  const direct = payload.msgId;
  if (direct !== undefined && direct !== null) {
    return String(direct);
  }
  const primary = payload.message?.msgId;
  if (primary !== undefined && primary !== null) {
    return String(primary);
  }
  const attachmentId = payload.attachment?.[0]?.msgId;
  if (attachmentId !== undefined && attachmentId !== null) {
    return String(attachmentId);
  }
  return undefined;
}

function resolveMediaFileName(params: {
  mediaUrl: string;
  fileName?: string;
  contentType?: string;
  kind?: string;
}): string {
  const explicit = params.fileName?.trim();
  if (explicit) {
    return explicit;
  }

  try {
    const parsed = new URL(params.mediaUrl);
    const fromPath = path.basename(parsed.pathname).trim();
    if (fromPath) {
      return fromPath;
    }
  } catch {
    // ignore URL parse failures
  }

  const ext =
    params.contentType === "image/png"
      ? "png"
      : params.contentType === "image/webp"
        ? "webp"
        : params.contentType === "image/jpeg"
          ? "jpg"
          : params.contentType === "video/mp4"
            ? "mp4"
            : params.contentType === "audio/mpeg"
              ? "mp3"
              : params.contentType === "audio/ogg"
                ? "ogg"
                : params.contentType === "audio/wav"
                  ? "wav"
                  : params.kind === "video"
                    ? "mp4"
                    : params.kind === "audio"
                      ? "mp3"
                      : params.kind === "image"
                        ? "jpg"
                        : "bin";

  return `upload.${ext}`;
}

function resolveUploadedVoiceAsset(
  uploaded: Array<{
    fileType?: string;
    fileUrl?: string;
    fileName?: string;
  }>,
): { fileUrl: string; fileName?: string } | undefined {
  for (const item of uploaded) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const fileType = item.fileType?.toLowerCase();
    const fileUrl = item.fileUrl?.trim();
    if (!fileUrl) {
      continue;
    }
    if (fileType === "others" || fileType === "video") {
      return { fileUrl, fileName: item.fileName?.trim() || undefined };
    }
  }
  return undefined;
}

function buildZaloVoicePlaybackUrl(asset: { fileUrl: string; fileName?: string }): string {
  // zca-js uses uploadAttachment(...).fileUrl directly for sendVoice.
  // Appending filename can produce URLs that play only in the local session.
  return asset.fileUrl.trim();
}

function mapFriend(friend: User): ZcaFriend {
  return {
    userId: String(friend.userId),
    displayName: friend.displayName || friend.zaloName || friend.username || String(friend.userId),
    avatar: friend.avatar || undefined,
  };
}

function mapGroup(groupId: string, group: GroupInfo & Record<string, unknown>): ZaloGroup {
  const totalMember =
    typeof group.totalMember === "number" && Number.isFinite(group.totalMember)
      ? group.totalMember
      : undefined;
  return {
    groupId: String(groupId),
    name: group.name?.trim() || String(groupId),
    memberCount: totalMember,
  };
}

function readCredentials(profile: string): StoredZaloCredentials | null {
  const filePath = resolveCredentialsPath(profile);
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoredZaloCredentials>;
    if (
      typeof parsed.imei !== "string" ||
      !parsed.imei ||
      !parsed.cookie ||
      typeof parsed.userAgent !== "string" ||
      !parsed.userAgent
    ) {
      return null;
    }
    return {
      imei: parsed.imei,
      cookie: parsed.cookie as Credentials["cookie"],
      userAgent: parsed.userAgent,
      language: typeof parsed.language === "string" ? parsed.language : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      lastUsedAt: typeof parsed.lastUsedAt === "string" ? parsed.lastUsedAt : undefined,
    };
  } catch {
    return null;
  }
}

function touchCredentials(profile: string): void {
  const existing = readCredentials(profile);
  if (!existing) {
    return;
  }
  const next: StoredZaloCredentials = {
    ...existing,
    lastUsedAt: new Date().toISOString(),
  };
  const dir = resolveCredentialsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolveCredentialsPath(profile), JSON.stringify(next, null, 2), "utf-8");
}

function writeCredentials(
  profile: string,
  credentials: Omit<StoredZaloCredentials, "createdAt" | "lastUsedAt">,
): void {
  const dir = resolveCredentialsDir();
  fs.mkdirSync(dir, { recursive: true });
  const existing = readCredentials(profile);
  const now = new Date().toISOString();
  const next: StoredZaloCredentials = {
    ...credentials,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
  };
  fs.writeFileSync(resolveCredentialsPath(profile), JSON.stringify(next, null, 2), "utf-8");
}

function clearCredentials(profile: string): boolean {
  const filePath = resolveCredentialsPath(profile);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

async function ensureApi(
  profileInput?: string | null,
  timeoutMs = API_LOGIN_TIMEOUT_MS,
): Promise<API> {
  const profile = normalizeProfile(profileInput);
  const cached = apiByProfile.get(profile);
  if (cached) {
    return cached;
  }

  const pending = apiInitByProfile.get(profile);
  if (pending) {
    return await pending;
  }

  const initPromise = (async () => {
    const stored = readCredentials(profile);
    if (!stored) {
      throw new Error(`No saved Zalo session for profile "${profile}"`);
    }
    const zalo = await createZalo({
      logging: false,
      selfListen: false,
    });
    const api = await withTimeout(
      zalo.login({
        imei: stored.imei,
        cookie: stored.cookie,
        userAgent: stored.userAgent,
        language: stored.language,
      }),
      timeoutMs,
      `Timed out restoring Zalo session for profile "${profile}"`,
    );
    apiByProfile.set(profile, api);
    touchCredentials(profile);
    return api;
  })();

  apiInitByProfile.set(profile, initPromise);
  try {
    return await initPromise;
  } catch (error) {
    apiByProfile.delete(profile);
    throw error;
  } finally {
    apiInitByProfile.delete(profile);
  }
}

function invalidateApi(profileInput?: string | null): void {
  const profile = normalizeProfile(profileInput);
  const api = apiByProfile.get(profile);
  if (api) {
    try {
      api.listener.stop();
    } catch {
      // ignore
    }
  }
  apiByProfile.delete(profile);
  apiInitByProfile.delete(profile);
}

function isQrLoginFresh(login: ActiveZaloQrLogin): boolean {
  return Date.now() - login.startedAt < QR_LOGIN_TTL_MS;
}

function resetQrLogin(profileInput?: string | null): void {
  const profile = normalizeProfile(profileInput);
  const active = activeQrLogins.get(profile);
  if (!active) {
    return;
  }
  try {
    active.abort?.();
  } catch {
    // ignore
  }
  activeQrLogins.delete(profile);
}

async function fetchGroupsByIds(api: API, ids: string[]): Promise<Map<string, GroupInfo>> {
  const result = new Map<string, GroupInfo>();
  for (let index = 0; index < ids.length; index += GROUP_INFO_CHUNK_SIZE) {
    const chunk = ids.slice(index, index + GROUP_INFO_CHUNK_SIZE);
    if (chunk.length === 0) {
      continue;
    }
    const response = await api.getGroupInfo(chunk);
    const map = response.gridInfoMap ?? {};
    for (const [groupId, info] of Object.entries(map)) {
      result.set(groupId, info);
    }
  }
  return result;
}

function makeGroupContextCacheKey(profile: string, groupId: string): string {
  return `${profile}:${groupId}`;
}

function readCachedGroupContext(profile: string, groupId: string): ZaloGroupContext | null {
  const key = makeGroupContextCacheKey(profile, groupId);
  const cached = groupContextCache.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    groupContextCache.delete(key);
    return null;
  }
  // Bump recency so hot groups stay in cache when enforcing max entries.
  groupContextCache.delete(key);
  groupContextCache.set(key, cached);
  return cached.value;
}

function trimGroupContextCache(now: number): void {
  for (const [key, value] of groupContextCache) {
    if (value.expiresAt > now) {
      continue;
    }
    groupContextCache.delete(key);
  }
  while (groupContextCache.size > GROUP_CONTEXT_CACHE_MAX_ENTRIES) {
    const oldestKey = groupContextCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    groupContextCache.delete(oldestKey);
  }
}

function writeCachedGroupContext(profile: string, context: ZaloGroupContext): void {
  const now = Date.now();
  const key = makeGroupContextCacheKey(profile, context.groupId);
  if (groupContextCache.has(key)) {
    groupContextCache.delete(key);
  }
  groupContextCache.set(key, {
    value: context,
    expiresAt: now + GROUP_CONTEXT_CACHE_TTL_MS,
  });
  trimGroupContextCache(now);
}

function clearCachedGroupContext(profile: string): void {
  for (const key of groupContextCache.keys()) {
    if (key.startsWith(`${profile}:`)) {
      groupContextCache.delete(key);
    }
  }
}

function extractGroupMembersFromInfo(
  groupInfo: (GroupInfo & { currentMems?: unknown[]; memVerList?: unknown[] }) | undefined,
): string[] | undefined {
  if (!groupInfo || !Array.isArray(groupInfo.currentMems)) {
    return undefined;
  }
  const members = groupInfo.currentMems
    .map((member) => {
      if (!member || typeof member !== "object") {
        return "";
      }
      const record = member as { dName?: unknown; zaloName?: unknown };
      return toStringValue(record.dName) || toStringValue(record.zaloName);
    })
    .filter(Boolean);
  if (members.length === 0) {
    return undefined;
  }
  return members;
}

function toInboundMessage(message: Message, ownUserId?: string): ZaloInboundMessage | null {
  const data = message.data;
  const isGroup = message.type === ThreadType.Group;
  // Các message type ngoài User(0) và Group(1) là kênh/trang broadcast.
  const isChannel = !isGroup && message.type !== ThreadType.User;
  const wrapperThreadId = toNumberId((message as Message & { threadId?: unknown }).threadId);
  const senderId = pickFirstNumberId(data, [
    "uidFrom",
    "fromUid",
    "senderUid",
    "senderId",
    "srcUid",
    "userId",
    // Kênh/trang: sender là page/channel, không có uidFrom
    "pageId",
    "fromPageId",
    "oaId",
    "fromId",
    "src",
  ]);
  const threadId = isGroup
    ? pickFirstNumberId(data, ["idTo", "threadId"]) || wrapperThreadId
    : isChannel
      ? pickFirstNonZeroNumberId(data, [
          "threadId",
          "pageId",
          "channelId",
          "oaId",
          "uidFrom",
          "fromUid",
          "senderUid",
          "senderId",
          "idTo",
        ]) || wrapperThreadId
      : wrapperThreadId ||
        pickFirstNumberId(data, ["uidFrom", "fromUid", "senderUid", "senderId"]) ||
        toNumberId(data.uidFrom) ||
        toNumberId(data.idTo);
  // Với kênh/trang: kênh chính là sender — fallback về threadId nếu không tìm được sender riêng.
  const resolvedSenderId = senderId || (isChannel ? threadId : "");
  if (!threadId || !resolvedSenderId) {
    return null;
  }
  const content = normalizeMessageContent(data.content);
  const normalizedOwnUserId = toNumberId(ownUserId);
  const mentionIds = extractMentionIds(data.mentions);
  const quoteOwnerId =
    data.quote && typeof data.quote === "object"
      ? toNumberId((data.quote as { ownerId?: unknown }).ownerId)
      : "";
  const hasAnyMention = mentionIds.length > 0;
  const canResolveExplicitMention = Boolean(normalizedOwnUserId);
  const wasExplicitlyMentioned = Boolean(
    normalizedOwnUserId && mentionIds.some((id) => id === normalizedOwnUserId),
  );
  const commandContent = wasExplicitlyMentioned
    ? stripOwnMentionsForCommandBody(content, data.mentions, normalizedOwnUserId)
    : hasAnyMention && !canResolveExplicitMention
      ? stripLeadingAtMentionForCommand(content)
      : content;
  const implicitMention = Boolean(
    normalizedOwnUserId && quoteOwnerId && quoteOwnerId === normalizedOwnUserId,
  );
  const eventMessage = buildEventMessage(data);
  const msgTypeRaw = toStringValue(data.msgType);
  return {
    threadId,
    isGroup,
    isChannel: isChannel || undefined,
    senderId: resolvedSenderId,
    senderName: typeof data.dName === "string" ? data.dName.trim() || undefined : undefined,
    groupName: isGroup ? resolveGroupNameFromMessageData(data) : undefined,
    msgType: msgTypeRaw || undefined,
    content,
    commandContent,
    timestampMs: resolveInboundTimestamp(data.ts),
    msgId: typeof data.msgId === "string" ? data.msgId : undefined,
    cliMsgId: typeof data.cliMsgId === "string" ? data.cliMsgId : undefined,
    hasAnyMention,
    canResolveExplicitMention,
    wasExplicitlyMentioned,
    implicitMention,
    eventMessage,
    raw: message,
  };
}

export function zalouserSessionExists(profileInput?: string | null): boolean {
  const profile = normalizeProfile(profileInput);
  return readCredentials(profile) !== null;
}

export async function checkZaloAuthenticated(profileInput?: string | null): Promise<boolean> {
  const profile = normalizeProfile(profileInput);
  if (!zalouserSessionExists(profile)) {
    return false;
  }
  try {
    const api = await ensureApi(profile, 12_000);
    await withTimeout(api.fetchAccountInfo(), 12_000, "Timed out checking Zalo session");
    return true;
  } catch {
    invalidateApi(profile);
    return false;
  }
}

export async function getZaloUserInfo(profileInput?: string | null): Promise<ZcaUserInfo | null> {
  const profile = normalizeProfile(profileInput);
  const api = await ensureApi(profile);
  const info = await api.fetchAccountInfo();
  const user = normalizeAccountInfoUser(info);
  if (!user?.userId) {
    return null;
  }
  return {
    userId: String(user.userId),
    displayName: user.displayName || user.zaloName || String(user.userId),
    avatar: user.avatar || undefined,
  };
}

export async function listZaloFriends(profileInput?: string | null): Promise<ZcaFriend[]> {
  const profile = normalizeProfile(profileInput);
  const api = await ensureApi(profile);
  const friends = await api.getAllFriends();
  return friends.map(mapFriend);
}

export async function listZaloFriendsMatching(
  profileInput: string | null | undefined,
  query?: string | null,
): Promise<ZcaFriend[]> {
  const friends = await listZaloFriends(profileInput);
  const q = query?.trim().toLowerCase();
  if (!q) {
    return friends;
  }
  const scored = friends
    .map((friend) => {
      const id = friend.userId.toLowerCase();
      const name = friend.displayName.toLowerCase();
      const exact = id === q || name === q;
      const includes = id.includes(q) || name.includes(q);
      return { friend, exact, includes };
    })
    .filter((entry) => entry.includes)
    .toSorted((a, b) => Number(b.exact) - Number(a.exact));
  return scored.map((entry) => entry.friend);
}

export async function listZaloGroups(profileInput?: string | null): Promise<ZaloGroup[]> {
  const profile = normalizeProfile(profileInput);
  const api = await ensureApi(profile);
  const allGroups = await api.getAllGroups();
  const ids = Object.keys(allGroups.gridVerMap ?? {});
  if (ids.length === 0) {
    return [];
  }
  const details = await fetchGroupsByIds(api, ids);
  const rows: ZaloGroup[] = [];
  for (const id of ids) {
    const info = details.get(id);
    if (!info) {
      rows.push({ groupId: id, name: id });
      continue;
    }
    rows.push(mapGroup(id, info as GroupInfo & Record<string, unknown>));
  }
  return rows;
}

export async function listZaloGroupsMatching(
  profileInput: string | null | undefined,
  query?: string | null,
): Promise<ZaloGroup[]> {
  const groups = await listZaloGroups(profileInput);
  const q = query?.trim().toLowerCase();
  if (!q) {
    return groups;
  }
  return groups.filter((group) => {
    const id = group.groupId.toLowerCase();
    const name = group.name.toLowerCase();
    return id.includes(q) || name.includes(q);
  });
}

export async function listZaloGroupMembers(
  profileInput: string | null | undefined,
  groupId: string,
): Promise<ZaloGroupMember[]> {
  const profile = normalizeProfile(profileInput);
  const api = await ensureApi(profile);

  const infoResponse = await api.getGroupInfo(groupId);
  const groupInfo = infoResponse.gridInfoMap?.[groupId] as
    | (GroupInfo & { memVerList?: unknown })
    | undefined;
  if (!groupInfo) {
    return [];
  }

  const memberIds = Array.isArray(groupInfo.memberIds)
    ? groupInfo.memberIds.map((id: unknown) => toNumberId(id)).filter(Boolean)
    : [];
  const memVerIds = Array.isArray(groupInfo.memVerList)
    ? groupInfo.memVerList.map((id: unknown) => toNumberId(id)).filter(Boolean)
    : [];
  const currentMembers = Array.isArray(groupInfo.currentMems) ? groupInfo.currentMems : [];

  const currentById = new Map<string, { displayName?: string; avatar?: string }>();
  for (const member of currentMembers) {
    const id = toNumberId(member?.id);
    if (!id) {
      continue;
    }
    currentById.set(id, {
      displayName: member.dName?.trim() || member.zaloName?.trim() || undefined,
      avatar: member.avatar || undefined,
    });
  }

  const uniqueIds = Array.from(
    new Set<string>([...memberIds, ...memVerIds, ...currentById.keys()]),
  );

  const profileMap = new Map<string, { displayName?: string; avatar?: string }>();
  if (uniqueIds.length > 0) {
    const profiles = await api.getGroupMembersInfo(uniqueIds);
    const profileEntries = profiles.profiles as Record<
      string,
      {
        id?: string;
        displayName?: string;
        zaloName?: string;
        avatar?: string;
      }
    >;
    for (const [rawId, profileValue] of Object.entries(profileEntries)) {
      const id = toNumberId(rawId) || toNumberId((profileValue as { id?: unknown })?.id);
      if (!id || !profileValue) {
        continue;
      }
      profileMap.set(id, {
        displayName: profileValue.displayName?.trim() || profileValue.zaloName?.trim() || undefined,
        avatar: profileValue.avatar || undefined,
      });
    }
  }

  return uniqueIds.map((id) => ({
    userId: id,
    displayName: profileMap.get(id)?.displayName || currentById.get(id)?.displayName || id,
    avatar: profileMap.get(id)?.avatar || currentById.get(id)?.avatar,
  }));
}

export async function resolveZaloGroupContext(
  profileInput: string | null | undefined,
  groupId: string,
): Promise<ZaloGroupContext> {
  const profile = normalizeProfile(profileInput);
  const normalizedGroupId = toNumberId(groupId) || groupId.trim();
  if (!normalizedGroupId) {
    throw new Error("groupId is required");
  }
  const cached = readCachedGroupContext(profile, normalizedGroupId);
  if (cached) {
    return cached;
  }

  const api = await ensureApi(profile);
  const response = await api.getGroupInfo(normalizedGroupId);
  const groupInfo = response.gridInfoMap?.[normalizedGroupId] as
    | (GroupInfo & { currentMems?: unknown[]; memVerList?: unknown[] })
    | undefined;
  const context: ZaloGroupContext = {
    groupId: normalizedGroupId,
    name: groupInfo?.name?.trim() || undefined,
    members: extractGroupMembersFromInfo(groupInfo),
  };
  writeCachedGroupContext(profile, context);
  return context;
}

export async function sendZaloTextMessage(
  threadId: string,
  text: string,
  options: ZaloSendOptions = {},
): Promise<ZaloSendResult> {
  const profile = normalizeProfile(options.profile);
  const trimmedThreadId = threadId.trim();
  if (!trimmedThreadId) {
    return { ok: false, error: "No threadId provided" };
  }

  const api = await ensureApi(profile);
  const type = options.isGroup ? ThreadType.Group : ThreadType.User;

  try {
    if (options.mediaUrl?.trim()) {
      const media = await loadOutboundMediaFromUrl(options.mediaUrl.trim(), {
        mediaLocalRoots: options.mediaLocalRoots,
      });
      const fileName = resolveMediaFileName({
        mediaUrl: options.mediaUrl,
        fileName: media.fileName,
        contentType: media.contentType,
        kind: media.kind,
      });
      const payloadText = (text || options.caption || "").slice(0, 2000);
      const textStyles = clampTextStyles(payloadText, options.textStyles);

      if (media.kind === "audio") {
        let textMessageId: string | undefined;
        if (payloadText) {
          const textResponse = await api.sendMessage(
            textStyles ? { msg: payloadText, styles: textStyles } : payloadText,
            trimmedThreadId,
            type,
          );
          textMessageId = extractSendMessageId(textResponse);
        }

        const attachmentFileName = fileName.includes(".") ? fileName : `${fileName}.bin`;
        const uploaded = await api.uploadAttachment(
          [
            {
              data: media.buffer,
              filename: attachmentFileName as `${string}.${string}`,
              metadata: {
                totalSize: media.buffer.length,
              },
            },
          ],
          trimmedThreadId,
          type,
        );
        const voiceAsset = resolveUploadedVoiceAsset(uploaded);
        if (!voiceAsset) {
          throw new Error("Failed to resolve uploaded audio URL for voice message");
        }
        const voiceUrl = buildZaloVoicePlaybackUrl(voiceAsset);
        const response = await api.sendVoice({ voiceUrl }, trimmedThreadId, type);
        return {
          ok: true,
          messageId: extractSendMessageId(response) ?? textMessageId,
        };
      }

      const response = await api.sendMessage(
        {
          msg: payloadText,
          ...(textStyles ? { styles: textStyles } : {}),
          attachments: [
            {
              data: media.buffer,
              filename: fileName.includes(".") ? fileName : `${fileName}.bin`,
              metadata: {
                totalSize: media.buffer.length,
              },
            },
          ],
        },
        trimmedThreadId,
        type,
      );
      return { ok: true, messageId: extractSendMessageId(response) };
    }

    const payloadText = text.slice(0, 2000);
    const textStyles = clampTextStyles(payloadText, options.textStyles);
    const response = await api.sendMessage(
      textStyles ? { msg: payloadText, styles: textStyles } : payloadText,
      trimmedThreadId,
      type,
    );
    return { ok: true, messageId: extractSendMessageId(response) };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function sendZaloTypingEvent(
  threadId: string,
  options: Pick<ZaloSendOptions, "profile" | "isGroup"> = {},
): Promise<void> {
  const profile = normalizeProfile(options.profile);
  const trimmedThreadId = threadId.trim();
  if (!trimmedThreadId) {
    throw new Error("No threadId provided");
  }
  const api = await ensureApi(profile);
  const type = options.isGroup ? ThreadType.Group : ThreadType.User;
  if ("sendTypingEvent" in api && typeof api.sendTypingEvent === "function") {
    await (api as API & ApiTypingCapability).sendTypingEvent(trimmedThreadId, type);
    return;
  }
  throw new Error("Zalo typing indicator is not supported by current API session");
}

async function resolveOwnUserId(api: API): Promise<string> {
  try {
    const info = await api.fetchAccountInfo();
    const resolved = toNumberId(normalizeAccountInfoUser(info)?.userId);
    if (resolved) {
      return resolved;
    }
  } catch {
    // Fall back to getOwnId when account info shape changes.
  }

  try {
    const ownId = toNumberId(api.getOwnId());
    if (ownId) {
      return ownId;
    }
  } catch {
    // Ignore fallback probe failures and keep mention detection conservative.
  }

  return "";
}

export async function sendZaloReaction(params: {
  profile?: string | null;
  threadId: string;
  isGroup?: boolean;
  msgId: string;
  cliMsgId: string;
  emoji: string;
  remove?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const profile = normalizeProfile(params.profile);
  const threadId = params.threadId.trim();
  const msgId = toStringValue(params.msgId);
  const cliMsgId = toStringValue(params.cliMsgId);
  if (!threadId || !msgId || !cliMsgId) {
    return { ok: false, error: "threadId, msgId, and cliMsgId are required" };
  }
  try {
    const api = await ensureApi(profile);
    const type = params.isGroup ? ThreadType.Group : ThreadType.User;
    const icon = params.remove
      ? { rType: -1, source: 6, icon: "" }
      : normalizeZaloReactionIcon(params.emoji);
    await api.addReaction(icon, {
      data: { msgId, cliMsgId },
      threadId,
      type,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function sendZaloDeliveredEvent(params: {
  profile?: string | null;
  isGroup?: boolean;
  message: ZaloEventMessage;
  isSeen?: boolean;
}): Promise<void> {
  const profile = normalizeProfile(params.profile);
  const api = await ensureApi(profile);
  const type = params.isGroup ? ThreadType.Group : ThreadType.User;
  await api.sendDeliveredEvent(params.isSeen === true, params.message, type);
}

export async function sendZaloSeenEvent(params: {
  profile?: string | null;
  isGroup?: boolean;
  message: ZaloEventMessage;
}): Promise<void> {
  const profile = normalizeProfile(params.profile);
  const api = await ensureApi(profile);
  const type = params.isGroup ? ThreadType.Group : ThreadType.User;
  await api.sendSeenEvent(params.message, type);
}

export async function sendZaloLink(
  threadId: string,
  url: string,
  options: ZaloSendOptions = {},
): Promise<ZaloSendResult> {
  const profile = normalizeProfile(options.profile);
  const trimmedThreadId = threadId.trim();
  const trimmedUrl = url.trim();
  if (!trimmedThreadId) {
    return { ok: false, error: "No threadId provided" };
  }
  if (!trimmedUrl) {
    return { ok: false, error: "No URL provided" };
  }

  try {
    const api = await ensureApi(profile);
    const type = options.isGroup ? ThreadType.Group : ThreadType.User;
    const response = await api.sendLink(
      { link: trimmedUrl, msg: options.caption },
      trimmedThreadId,
      type,
    );
    return { ok: true, messageId: String(response.msgId) };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function startZaloQrLogin(params: {
  profile?: string | null;
  force?: boolean;
  timeoutMs?: number;
}): Promise<{ qrDataUrl?: string; message: string }> {
  const profile = normalizeProfile(params.profile);

  if (!params.force && (await checkZaloAuthenticated(profile))) {
    const info = await getZaloUserInfo(profile).catch(() => null);
    const name = info?.displayName ? ` (${info.displayName})` : "";
    return {
      message: `Zalo is already linked${name}.`,
    };
  }

  if (params.force) {
    await logoutZaloProfile(profile);
  }

  const existing = activeQrLogins.get(profile);
  if (existing && isQrLoginFresh(existing)) {
    if (existing.qrDataUrl) {
      return {
        qrDataUrl: existing.qrDataUrl,
        message: "QR already active. Scan it with the Zalo app.",
      };
    }
  } else if (existing) {
    resetQrLogin(profile);
  }

  if (!activeQrLogins.has(profile)) {
    const login: ActiveZaloQrLogin = {
      id: randomUUID(),
      profile,
      startedAt: Date.now(),
      connected: false,
      waitPromise: Promise.resolve(),
    };

    login.waitPromise = (async () => {
      let capturedCredentials: Omit<StoredZaloCredentials, "createdAt" | "lastUsedAt"> | null =
        null;
      try {
        const zalo = await createZalo({ logging: false, selfListen: false });
        const api = await zalo.loginQR(undefined, (event: LoginQRCallbackEvent) => {
          const current = activeQrLogins.get(profile);
          if (!current || current.id !== login.id) {
            return;
          }

          if (event.actions?.abort) {
            current.abort = () => {
              try {
                event.actions?.abort?.();
              } catch {
                // ignore
              }
            };
          }

          switch (event.type) {
            case LoginQRCallbackEventType.QRCodeGenerated: {
              const image = event.data.image.replace(/^data:image\/png;base64,/, "");
              current.qrDataUrl = image.startsWith("data:image")
                ? image
                : `data:image/png;base64,${image}`;
              break;
            }
            case LoginQRCallbackEventType.QRCodeExpired: {
              try {
                event.actions.retry();
              } catch {
                current.error = "QR expired before confirmation. Start login again.";
              }
              break;
            }
            case LoginQRCallbackEventType.QRCodeDeclined: {
              current.error = "QR login was declined on the phone.";
              break;
            }
            case LoginQRCallbackEventType.GotLoginInfo: {
              capturedCredentials = {
                imei: event.data.imei,
                cookie: event.data.cookie,
                userAgent: event.data.userAgent,
              };
              break;
            }
            default:
              break;
          }
        });

        const current = activeQrLogins.get(profile);
        if (!current || current.id !== login.id) {
          return;
        }

        if (!capturedCredentials) {
          const ctx = api.getContext();
          const cookieJar = api.getCookie();
          const cookieJson = cookieJar.toJSON();
          capturedCredentials = {
            imei: ctx.imei,
            cookie: cookieJson?.cookies ?? [],
            userAgent: ctx.userAgent,
            language: ctx.language,
          };
        }

        writeCredentials(profile, capturedCredentials);
        invalidateApi(profile);
        apiByProfile.set(profile, api);
        current.connected = true;
      } catch (error) {
        const current = activeQrLogins.get(profile);
        if (current && current.id === login.id) {
          current.error = toErrorMessage(error);
        }
      }
    })();

    activeQrLogins.set(profile, login);
  }

  const active = activeQrLogins.get(profile);
  if (!active) {
    return { message: "Failed to initialize Zalo QR login." };
  }

  const timeoutMs = Math.max(params.timeoutMs ?? DEFAULT_QR_START_TIMEOUT_MS, 3000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (active.error) {
      resetQrLogin(profile);
      return {
        message: `Failed to start QR login: ${active.error}`,
      };
    }
    if (active.connected) {
      resetQrLogin(profile);
      return {
        message: "Zalo already connected.",
      };
    }
    if (active.qrDataUrl) {
      return {
        qrDataUrl: active.qrDataUrl,
        message: "Scan this QR with the Zalo app.",
      };
    }
    await delay(150);
  }

  return {
    message: "Still preparing QR. Call wait to continue checking login status.",
  };
}

export async function waitForZaloQrLogin(params: {
  profile?: string | null;
  timeoutMs?: number;
}): Promise<ZaloAuthStatus> {
  const profile = normalizeProfile(params.profile);
  const active = activeQrLogins.get(profile);

  if (!active) {
    const connected = await checkZaloAuthenticated(profile);
    return {
      connected,
      message: connected ? "Zalo session is ready." : "No active Zalo QR login in progress.",
    };
  }

  if (!isQrLoginFresh(active)) {
    resetQrLogin(profile);
    return {
      connected: false,
      message: "QR login expired. Start again to generate a fresh QR code.",
    };
  }

  const timeoutMs = Math.max(params.timeoutMs ?? DEFAULT_QR_WAIT_TIMEOUT_MS, 1000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (active.error) {
      const message = `Zalo login failed: ${active.error}`;
      resetQrLogin(profile);
      return {
        connected: false,
        message,
      };
    }
    if (active.connected) {
      resetQrLogin(profile);
      return {
        connected: true,
        message: "Login successful.",
      };
    }
    await Promise.race([active.waitPromise, delay(400)]);
  }

  return {
    connected: false,
    message: "Still waiting for QR scan confirmation.",
  };
}

export async function logoutZaloProfile(profileInput?: string | null): Promise<{
  cleared: boolean;
  loggedOut: boolean;
  message: string;
}> {
  const profile = normalizeProfile(profileInput);
  resetQrLogin(profile);
  clearCachedGroupContext(profile);

  const listener = activeListeners.get(profile);
  if (listener) {
    try {
      listener.stop();
    } catch {
      // ignore
    }
    activeListeners.delete(profile);
  }

  invalidateApi(profile);
  const cleared = clearCredentials(profile);

  return {
    cleared,
    loggedOut: true,
    message: cleared ? "Logged out and cleared local session." : "No local session to clear.",
  };
}

export async function startZaloListener(params: {
  accountId: string;
  profile?: string | null;
  abortSignal: AbortSignal;
  onMessage: (message: ZaloInboundMessage) => void;
  onError: (error: Error) => void;
}): Promise<{ stop: () => void }> {
  const profile = normalizeProfile(params.profile);

  const existing = activeListeners.get(profile);
  if (existing) {
    throw new Error(
      `Zalo listener already running for profile "${profile}" (account "${existing.accountId}")`,
    );
  }

  const api = await ensureApi(profile);
  const ownUserId = await resolveOwnUserId(api);
  const directorySnapshot = shouldLogZalouserRawInbound()
    ? await loadDirectorySnapshotForLogs(api, profile)
    : { friends: new Map<string, string>(), groups: new Map<string, string>() };
  let stopped = false;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let oldMessagesTimer: ReturnType<typeof setInterval> | null = null;
  let detachWsFrameTap: (() => void) | null = null;
  let lastWatchdogTickAt = Date.now();
  const oldMessagesBaselineSeen = new Set<number>();
  let oldMessagesConnected = false;
  const seenInboundKeys = new Set<string>();
  const seenInboundOrder: string[] = [];

  const cleanup = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (oldMessagesTimer) {
      clearInterval(oldMessagesTimer);
      oldMessagesTimer = null;
    }
    if (detachWsFrameTap) {
      detachWsFrameTap();
      detachWsFrameTap = null;
    }
    try {
      api.listener.off("connected", onConnected);
      api.listener.off("message", onMessage);
      api.listener.off("old_messages", onOldMessages);
      api.listener.off("error", onError);
      api.listener.off("closed", onClosed);
    } catch {
      // ignore listener detachment errors
    }
    try {
      api.listener.stop();
    } catch {
      // ignore
    }
    activeListeners.delete(profile);
  };

  const dispatchNormalized = (normalized: ZaloInboundMessage): void => {
    const key = resolveInboundDedupeKey(normalized);
    if (!rememberInboundDedupeKey({ key, seen: seenInboundKeys, order: seenInboundOrder })) {
      return;
    }
    params.onMessage(normalized);
  };

  const onMessage = (incoming: Message) => {
    const dbg = shouldLogZalouserRawInbound();
    if (incoming.isSelf) {
      if (dbg) {
        const wrap = incoming as Message & { threadId?: unknown };
        writeZalouserInboundDiag(
          `[zalouser][skip-self] type=${incoming.type} threadId=${String(wrap.threadId ?? "")}`,
        );
      }
      return;
    }
    if (dbg) {
      try {
        const wrap = incoming as Message & { threadId?: unknown };
        const snippet = JSON.stringify(incoming.data ?? {}).slice(0, 8000);
        writeZalouserInboundDiag(
          `[zalouser][raw-inbound] type=${incoming.type} threadId=${String(wrap.threadId ?? "")} data=${snippet}`,
        );
      } catch {
        writeZalouserInboundDiag("[zalouser][raw-inbound] (không serialize được payload)");
      }
    }
    const normalized = toInboundMessage(incoming, ownUserId);
    if (!normalized) {
      if (dbg) {
        writeZalouserInboundDiag(
          `[zalouser][drop-null] toInboundMessage trả null — kiểm tra uidFrom/idTo/msgType. ${explainToInboundNull(incoming, ownUserId)}`,
        );
      }
      return;
    }
    if (dbg) {
      writeZalouserInboundDiag(
        `[zalouser][inbound-normalized] ${summarizeInboundMessageForLog({
          message: normalized,
          directory: directorySnapshot,
        })}`,
      );
    }
    dispatchNormalized(normalized);
  };

  const onDecodedMessageBatch = (batch: DecodedZaloWsMessageBatch, header: ZaloWsFrameHeader) => {
    if (stopped || params.abortSignal.aborted) {
      return;
    }
    const dbg = shouldLogZalouserRawInbound();
    const normalizedMessages: ZaloInboundMessage[] = [];
    for (const [index, incoming] of batch.messages.entries()) {
      if (incoming.isSelf || isLikelyOwnDecodedPageMessage(incoming, ownUserId)) {
        if (dbg) {
          writeZalouserInboundDiag(
            `[zalouser][decoded-inbound-skip-self] source=${batch.source} cmd=${header.cmd} subCmd=${header.subCmd} index=${index} type=${incoming.type} threadId=${incoming.threadId}`,
          );
        }
        continue;
      }
      if (dbg) {
        try {
          writeZalouserInboundDiag(
            `[zalouser][decoded-inbound-raw] source=${batch.source} cmd=${header.cmd} subCmd=${header.subCmd} index=${index} type=${incoming.type} threadId=${incoming.threadId} data=${JSON.stringify(
              incoming.data ?? {},
            ).slice(0, 8000)}`,
          );
        } catch {
          writeZalouserInboundDiag(
            `[zalouser][decoded-inbound-raw] source=${batch.source} cmd=${header.cmd} subCmd=${header.subCmd} index=${index} (không serialize được payload)`,
          );
        }
      }
      const normalized = toInboundMessage(incoming, ownUserId);
      if (!normalized) {
        if (dbg) {
          writeZalouserInboundDiag(
            `[zalouser][decoded-inbound-drop-null] source=${batch.source} ${explainToInboundNull(
              incoming,
              ownUserId,
            )}`,
          );
        }
        continue;
      }
      if (dbg) {
        writeZalouserInboundDiag(
          `[zalouser][decoded-inbound-normalized] source=${batch.source} ${summarizeInboundMessageForLog(
            {
              message: normalized,
              directory: directorySnapshot,
            },
          )}`,
        );
      }
      normalizedMessages.push(normalized);
    }
    const isDecodedOldPageMessages =
      batch.source === "decoded_pageMsgs" && header.cmd === 510 && header.subCmd === 1;
    if (isDecodedOldPageMessages && !oldMessagesBaselineSeen.has(ZALO_CHANNEL_THREAD_TYPE)) {
      oldMessagesBaselineSeen.add(ZALO_CHANNEL_THREAD_TYPE);
      const replayBaseline = true;
      if (dbg) {
        writeZalouserInboundDiag(
          `[zalouser][decoded-old-messages-baseline] type=channel count=${normalizedMessages.length} replay=${replayBaseline}`,
        );
      }
      if (!replayBaseline) {
        for (const normalized of normalizedMessages) {
          const key = resolveInboundDedupeKey(normalized);
          rememberInboundDedupeKey({ key, seen: seenInboundKeys, order: seenInboundOrder });
        }
        return;
      }
    }
    for (const normalized of normalizedMessages) {
      dispatchNormalized(normalized);
    }
  };

  const onOldMessages = (messages: Message[], type: number) => {
    const dbg = shouldLogZalouserRawInbound();
    const replayBaseline = true;
    const normalizedMessages: ZaloInboundMessage[] = [];
    for (const [index, incoming] of messages.entries()) {
      if (incoming.isSelf) {
        continue;
      }
      if (dbg) {
        try {
          writeZalouserInboundDiag(
            `[zalouser][old-messages-raw] type=${type} index=${index} data=${JSON.stringify(
              incoming.data ?? {},
            ).slice(0, 8000)}`,
          );
        } catch {
          writeZalouserInboundDiag(
            `[zalouser][old-messages-raw] type=${type} index=${index} (không serialize được payload)`,
          );
        }
      }
      const normalized = toInboundMessage(incoming, ownUserId);
      if (!normalized) {
        if (dbg) {
          writeZalouserInboundDiag(
            `[zalouser][old-messages-drop-null] ${explainToInboundNull(incoming, ownUserId)}`,
          );
        }
        continue;
      }
      normalizedMessages.push(normalized);
    }
    if (dbg) {
      normalizedMessages.forEach((normalized, index) => {
        writeZalouserInboundDiag(
          `[zalouser][old-messages-item] ${summarizeInboundMessageForLog({
            message: normalized,
            index,
            historyType: type,
            directory: directorySnapshot,
          })}`,
        );
      });
    }
    if (!oldMessagesBaselineSeen.has(type)) {
      oldMessagesBaselineSeen.add(type);
      if (dbg) {
        writeZalouserInboundDiag(
          `[zalouser][old-messages-baseline] type=${
            type === ThreadType.Group ? "group" : "user"
          } count=${normalizedMessages.length} replay=${replayBaseline}`,
        );
      }
      if (replayBaseline) {
        for (const normalized of normalizedMessages) {
          dispatchNormalized(normalized);
        }
        return;
      }
      for (const normalized of normalizedMessages) {
        const key = resolveInboundDedupeKey(normalized);
        rememberInboundDedupeKey({ key, seen: seenInboundKeys, order: seenInboundOrder });
      }
      return;
    }
    for (const normalized of normalizedMessages) {
      dispatchNormalized(normalized);
    }
  };

  const failListener = (error: Error) => {
    if (stopped || params.abortSignal.aborted) {
      return;
    }
    cleanup();
    invalidateApi(profile);
    params.onError(error);
  };

  const onError = (error: unknown) => {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    failListener(wrapped);
  };

  const onClosed = (code: number, reason: string) => {
    failListener(new Error(`Zalo listener closed (${code}): ${reason || "no reason"}`));
  };

  const oldMessagesSyncIntervalMs = resolveOldMessagesSyncIntervalMs();
  const requestOldMessagesForType = (type: number) => {
    if (
      stopped ||
      params.abortSignal.aborted ||
      oldMessagesSyncIntervalMs <= 0 ||
      !oldMessagesConnected
    ) {
      return;
    }
    try {
      api.listener.requestOldMessages(type);
    } catch (error) {
      if (shouldLogZalouserRawInbound()) {
        writeZalouserInboundDiag(
          `[zalouser][old-messages-request-error] type=${
            type === ThreadType.Group ? "group" : "user"
          } ${toErrorMessage(error)}`,
        );
      }
    }
  };

  const requestOldMessagesForAllTypes = () => {
    requestOldMessagesForType(ThreadType.User);
    requestOldMessagesForType(ThreadType.Group);
  };

  const onConnected = () => {
    oldMessagesConnected = true;
    requestOldMessagesForAllTypes();
  };

  api.listener.on("connected", onConnected);
  api.listener.on("message", onMessage);
  api.listener.on("old_messages", onOldMessages);
  api.listener.on("error", onError);
  api.listener.on("closed", onClosed);

  try {
    api.listener.start({ retryOnClose: false });
    detachWsFrameTap = installZaloWsFrameTap(api.listener, profile, onDecodedMessageBatch);
  } catch (error) {
    cleanup();
    throw error;
  }

  if (shouldLogZalouserRawInbound()) {
    writeZalouserInboundDiag(
      `[zalouser][diag] OPENCLAW_ZALOUSER_LOG_RAW_INBOUND=bật — listener Zalo đã start (profile=${profile}). Sẽ có [raw-inbound]/[drop-null] khi có tin từ socket. Nếu không thấy dòng [diag] này sau restart: chạy \`pnpm build\` trong core/openclaw-zero-token rồi ./server.sh restart.`,
    );
  }

  if (oldMessagesSyncIntervalMs > 0) {
    oldMessagesTimer = setInterval(requestOldMessagesForAllTypes, oldMessagesSyncIntervalMs);
    oldMessagesTimer.unref?.();
  }

  watchdogTimer = setInterval(() => {
    if (stopped || params.abortSignal.aborted) {
      return;
    }
    const now = Date.now();
    const gapMs = now - lastWatchdogTickAt;
    lastWatchdogTickAt = now;
    if (gapMs <= LISTENER_WATCHDOG_MAX_GAP_MS) {
      return;
    }
    failListener(
      new Error(
        `Zalo listener watchdog gap detected (${Math.round(gapMs / 1000)}s): forcing reconnect`,
      ),
    );
  }, LISTENER_WATCHDOG_INTERVAL_MS);
  watchdogTimer.unref?.();

  params.abortSignal.addEventListener(
    "abort",
    () => {
      cleanup();
    },
    { once: true },
  );

  activeListeners.set(profile, {
    profile,
    accountId: params.accountId,
    stop: cleanup,
  });

  return { stop: cleanup };
}

export async function resolveZaloGroupsByEntries(params: {
  profile?: string | null;
  entries: string[];
}): Promise<Array<{ input: string; resolved: boolean; id?: string }>> {
  const groups = await listZaloGroups(params.profile);
  const byName = new Map<string, ZaloGroup[]>();
  for (const group of groups) {
    const key = group.name.trim().toLowerCase();
    if (!key) {
      continue;
    }
    const list = byName.get(key) ?? [];
    list.push(group);
    byName.set(key, list);
  }

  return params.entries.map((input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      return { input, resolved: false };
    }
    if (/^\d+$/.test(trimmed)) {
      return { input, resolved: true, id: trimmed };
    }
    const candidates = byName.get(trimmed.toLowerCase()) ?? [];
    const match = candidates[0];
    return match ? { input, resolved: true, id: match.groupId } : { input, resolved: false };
  });
}

export async function resolveZaloAllowFromEntries(params: {
  profile?: string | null;
  entries: string[];
}): Promise<Array<{ input: string; resolved: boolean; id?: string; note?: string }>> {
  const friends = await listZaloFriends(params.profile);
  const byName = new Map<string, ZcaFriend[]>();
  for (const friend of friends) {
    const key = friend.displayName.trim().toLowerCase();
    if (!key) {
      continue;
    }
    const list = byName.get(key) ?? [];
    list.push(friend);
    byName.set(key, list);
  }

  return params.entries.map((input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      return { input, resolved: false };
    }
    if (/^\d+$/.test(trimmed)) {
      return { input, resolved: true, id: trimmed };
    }
    const matches = byName.get(trimmed.toLowerCase()) ?? [];
    const match = matches[0];
    if (!match) {
      return { input, resolved: false };
    }
    return {
      input,
      resolved: true,
      id: match.userId,
      note: matches.length > 1 ? "multiple matches; chose first" : undefined,
    };
  });
}

export async function clearProfileRuntimeArtifacts(profileInput?: string | null): Promise<void> {
  const profile = normalizeProfile(profileInput);
  resetQrLogin(profile);
  clearCachedGroupContext(profile);
  const listener = activeListeners.get(profile);
  if (listener) {
    listener.stop();
    activeListeners.delete(profile);
  }
  invalidateApi(profile);
  await fsp.mkdir(resolveCredentialsDir(), { recursive: true }).catch(() => undefined);
}

/** Dùng trong Vitest / gỡ lỗi payload OA–card (không bắt buộc cho runtime). */
export function zalouserNormalizeInboundContentForTest(content: unknown): string {
  return normalizeZaloInboundTextContent(content);
}

/** Dùng trong Vitest — map `Message` zca-js → `ZaloInboundMessage`. */
export function zalouserBuildInboundFromZcaForTest(
  message: Message,
  ownUserId?: string,
): ZaloInboundMessage | null {
  return toInboundMessage(message, ownUserId);
}

/** Dùng trong Vitest — đọc header frame WebSocket thô của zca-js. */
export function zalouserDecodeWsFrameHeaderForTest(data: unknown): ZaloWsFrameHeader | null {
  return decodeZaloWsFrameHeader(data);
}

/** Dùng trong Vitest — trích batch tin nhắn đã decode từ frame socket. */
export function zalouserExtractDecodedWsBatchesForTest(
  decoded: unknown,
  options?: ExtractDecodedZaloWsMessageBatchesOptions,
): DecodedZaloWsMessageBatch[] {
  return extractDecodedZaloWsMessageBatches(decoded, options);
}
