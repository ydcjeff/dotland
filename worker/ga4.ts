// Copyright 2021-2022 the Deno authors. All rights reserved. MIT license.

import { ConnInfo } from "https://deno.land/std@0.120.0/http/server.ts";
import { STATUS_TEXT } from "https://deno.land/std@0.120.0/http/http_status.ts";
import snakeCase from "https://deno.land/x/case@2.1.1/snakeCase.ts";

const GA4_ENDPOINT_URL = "https://www.google-analytics.com/g/collect";
const SLOW_UPLOAD_THRESHOLD = 1_000;

export type Primitive = bigint | boolean | null | number | string;

export interface GA4Report {
  measurementId?: string;
  client: Client;
  user: User;
  session?: Session;
  campaign?: Campaign;
  page: Page;
  events: [PrimaryEvent, ...Event[]];
}

export type Client = {
  id?: string; // Must have either `ip` or `id`.
  ip?: string;
  language?: string;
  headers: Headers;
};

export interface User {
  id?: string;
  properties: Record<string, Primitive>;
}

export interface Session {
  id: string;
  number: number;
  engaged: boolean;
  start?: boolean;
  hitCount: number;
}

export interface Page {
  location: string;
  title: string;
  referrer?: string;
  ignoreReferrer?: boolean;
  trafficType?: "direct" | "organic" | "referral" | "internal" | "custom";
  firstVisit?: boolean;
  newToSite?: boolean;
}
export interface Campaign {
  source: string;
  medium: string;
  id?: string;
  name?: string;
  content?: string;
  term?: string;
}

export interface Event {
  name: string;
  category?: string;
  label?: string;
  params: Record<string, Primitive>;
}

// Defaults to "page_view", but can be overridden/surpressed.
export type PrimaryEvent = Event | null;

export interface GA4Init {
  measurementId?: string;
  request: Request;
  response: Response;
  conn: ConnInfo;
}

export class GA4Report {
  constructor({ measurementId, request, response, conn }: GA4Init) {
    this.measurementId = measurementId;
    this.client = {
      ip: getClientIp(request, conn),
      language: getClientLanguage(request),
      headers: getClientHeaders(request),
    };
    this.user = { properties: {} };
    this.session = getSession(conn);
    this.page = {
      location: request.url,
      title: getPageTitle(request, response),
      referrer: getPageReferrer(request),
    };
    if (this.page.referrer != null) {
      this.page.trafficType = "referral";
    }
    this.campaign = undefined;
    this.events = [{ name: "page_view", params: {} }];
  }

  get event(): PrimaryEvent {
    return this.events[0];
  }

  set event(event: PrimaryEvent) {
    this.events[0] = event;
  }

  async send(): Promise<void> {
    // Short circuit if there are no events to report.
    if (!this.events.find(Boolean)) {
      return;
    }

    this.measurementId ??= Deno.env.get("GA4_MEASUREMENT_ID");
    if (!this.measurementId) {
      return this.warn(
        "GA4_MEASUREMENT_ID environment variable not set. " +
          "Google Analytics reporting disabled.",
      );
    }

    if (this.client.id == null) {
      if (this.client.ip == null) {
        return this.warn("either `client.id` or `client.ip` must be set.");
      }
      const material = [
        this.client.ip,
        this.client.headers.get("user-agent"),
        this.client.headers.get("sec-ch-ua"),
      ].join();
      this.client.id = await toDigest(material);
    }

    // Note that the order in which parameters appear in the query string does
    // matter.
    const queryParams: Record<string, string> = {};

    // Version; must be set to "2" to send events to GA4.
    maybeAddShortParam(queryParams, "v", 2);
    maybeAddShortParam(queryParams, "tid", this.measurementId);

    maybeAddShortParam(queryParams, "cid", this.client.id);
    maybeAddShortParam(queryParams, "ul", this.client.language);
    maybeAddShortParam(queryParams, "_uip", this.client.ip);

    maybeAddShortParam(queryParams, "uid", this.user.id);

    maybeAddShortParam(queryParams, "cs", this.campaign?.source);
    maybeAddShortParam(queryParams, "cm", this.campaign?.medium);
    maybeAddShortParam(queryParams, "ci", this.campaign?.id);
    maybeAddShortParam(queryParams, "cn", this.campaign?.name);
    maybeAddShortParam(queryParams, "cc", this.campaign?.content);
    maybeAddShortParam(queryParams, "ck", this.campaign?.term);

    maybeAddShortParam(queryParams, "sid", this.session?.id);
    maybeAddShortParam(queryParams, "sct", this.session?.number);
    maybeAddShortParam(queryParams, "seg", this.session?.engaged);
    maybeAddShortParam(queryParams, "_s", this.session?.hitCount);

    maybeAddShortParam(queryParams, "dl", this.page.location);
    maybeAddShortParam(queryParams, "dr", this.page.referrer);
    maybeAddShortParam(queryParams, "dt", this.page.title);
    maybeAddShortParam(queryParams, "ir", this.page.ignoreReferrer);
    maybeAddShortParam(queryParams, "tt", this.page.trafficType);

    if (this.event != null) {
      for (const prop of ["category", "label"] as const) {
        maybeAddCustomEventParam(
          queryParams,
          "ep",
          `event_${prop}`,
          this.event[prop],
        );
      }
      for (const [name, value] of Object.entries(this.event.params)) {
        maybeAddCustomEventParam(queryParams, "ep", name, value);
      }

      maybeAddShortParam(queryParams, "en", this.event.name);

      maybeAddShortParam(queryParams, "_fv", this.page.firstVisit);
      maybeAddShortParam(queryParams, "_nsi", this.page.newToSite);
      maybeAddShortParam(queryParams, "_ss", this.session?.start);
    }

    for (const [name, value] of Object.entries(this.user.properties)) {
      maybeAddCustomEventParam(queryParams, "up", name, value);
    }

    const extraEvents = this.events.slice(1) as Event[];
    const eventParamsList = extraEvents.map((event) => {
      const eventParams: Record<string, string> = {};
      // Inside the body, the event name must be placed *before* the parameters.
      maybeAddShortParam(eventParams, "en", event.name);
      for (const prop of ["category", "label"] as const) {
        maybeAddCustomEventParam(
          eventParams,
          "ep",
          `event_${prop}`,
          event[prop],
        );
      }
      for (const [name, value] of Object.entries(event.params)) {
        maybeAddCustomEventParam(eventParams, "ep", name, value);
      }
      return eventParams;
    });

    const url = Object.assign(new URL(GA4_ENDPOINT_URL), {
      search: String(new URLSearchParams(queryParams)),
    }).href;

    const headers = this.client.headers;

    const body = eventParamsList.map((eventParams) =>
      new URLSearchParams(eventParams).toString()
    ).join("\n");

    const request = new Request(url, { method: "POST", headers, body });

    // console.log(`${url}\n${body}\n======`);

    try {
      const start = performance.now();
      const response = await fetch(request);
      const duration = performance.now() - start;

      if (this.session && response.ok) {
        if (this.event != null) {
          this.session.start = undefined;
        }
        const hitCount = this.events.filter(Boolean).length || 1;
        this.session.hitCount += hitCount;
      }

      if (response.status !== 204 || duration >= SLOW_UPLOAD_THRESHOLD) {
        this.warn(
          `${this.events.length} events uploaded in ${duration}ms. ` +
            `Response: ${response.status} ${response.statusText}`,
        );
        // Google tells us not to retry when it reports a non-2xx status code.
      }
    } catch (err) {
      this.warn(`Upload failed: ${err}`);
    }
  }

  warn(message: unknown) {
    console.warn(`GA4: ${message}`);
  }
}

function getClientIp(request: Request, conn: ConnInfo): string {
  const xForwardedFor = request.headers.get("x-forwarded-for");
  if (xForwardedFor) {
    return xForwardedFor.split(/\s*,\s*/)[0];
  } else {
    return (conn.remoteAddr as Deno.NetAddr).hostname;
  }
}

function getClientLanguage(request: Request): string | undefined {
  const acceptLanguage = request.headers.get("accept-language");
  if (acceptLanguage == null) {
    return;
  }
  const code = acceptLanguage.split(/[^a-z-]+/i).filter(Boolean).shift();
  if (code == null) {
    return undefined;
  }
  return code.toLowerCase();
}

function getClientHeaders(request: Request): Headers {
  const headerList = [...request.headers.entries()].filter(([name, _value]) => {
    name = name.toLowerCase();
    return name === "user-agent" || name === "sec-ch-ua" ||
      name.startsWith("sec-ch-ua-");
  });
  return new Headers(headerList);
}

const START_OF_2020 = new Date("2020-01-01T00:00:00.000Z").getTime();
const MINUTE = 60 * 1000;
const sessionMap = new WeakMap<ConnInfo, Session>();

function getSession(conn: ConnInfo): Session {
  let session = sessionMap.get(conn);
  if (session == null) {
    // Generate a random session id.
    const id = (Math.random() * 2 ** 52).toString(36).padStart(10, "0");
    const number = Math.floor((Date.now() - START_OF_2020) / MINUTE);
    // Note: we currently cannot in any way determine an accurate "session
    // count" value. However we have to report something (otherwise GA ignores
    // our sessions), so we always use the value `1`. Hopefully that doesn't
    // cause too much weirdness down the line.
    session = { id, number, engaged: true, start: true, hitCount: 0 };
    sessionMap.set(conn, session);
  }
  return session;
}

function getPageReferrer(request: Request): string | undefined {
  const referrer = request.headers.get("referer");
  if (
    referrer !== null && new URL(referrer).host !== new URL(request.url).host
  ) {
    return referrer;
  }
}

function getPageTitle(request: Request, response: Response): string {
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    isSuccess(response)
  ) {
    return new URL(request.url)
      .pathname
      .replace(/\.[^\/]*$/, "") // Remove file extension.
      .split(/\/+/) // Split into components.
      .map(decodeURIComponent) // Unescape.
      .map((s) => s.replace(/[\s_]+/g, " ")) // Underbars to spaces.
      .map((s) => s.replace(/@v?[\d\.\s]+$/, "")) // Remove version number.
      .map((s) => s.trim()) // Trim leading/trailing whitespace.
      .filter(Boolean) // Remove empty path components.
      .join(" / ") ||
      "(top level)";
  } else {
    return formatStatus(response).toLowerCase();
  }
}

export function formatStatus(response: Response): string {
  let { status, statusText } = response;
  statusText ||= STATUS_TEXT.get(status) ?? "Invalid Status";
  return `${status} ${statusText}`;
}

export function isSuccess(response: Response): boolean {
  const { status } = response;
  return status >= 200 && status <= 299;
}

export function isRedirect(response: Response): boolean {
  const { status } = response;
  return status >= 300 && status <= 399;
}

export function isServerError(response: Response): boolean {
  const { status } = response;
  return status >= 500 && status <= 599;
}

function maybeAddShortParam(
  params: Record<string, string>,
  name: string,
  value?: Primitive,
) {
  if (value == null) {
    // Do nothing.
  } else if (typeof value === "boolean") {
    params[name] = value ? "1" : "0";
  } else {
    params[name] = String(value);
  }
}

function maybeAddCustomEventParam(
  params: Record<string, string>,
  prefix: string,
  name: string,
  value?: Primitive,
) {
  if (value === undefined) {
    return; // Do nothing.
  }
  name = snakeCase(name);
  if (typeof value === "number" || typeof value === "bigint") {
    params[`${prefix}n.${name}`] = String(value);
  } else {
    params[`${prefix}.${name}`] = String(value);
  }
}

const encoder = new TextEncoder();

/** Create a SHA-1 hex string digest of the supplied message. */
async function toDigest(msg: string): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-1", encoder.encode(msg));
  return Array.from(new Uint8Array(buffer)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}