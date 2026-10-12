import { expect, test } from "bun:test";
import { clientIp } from "../../src/platform/server.ts";

/** A-02: X-Forwarded-For is honoured only behind a configured trusted proxy. */
test("without trusted proxies the socket address wins and X-Forwarded-For is ignored", () => {
  expect(clientIp("203.0.113.9", "10.0.0.5", [])).toBe("10.0.0.5");
  expect(clientIp("203.0.113.9, 10.0.0.1", "198.51.100.7", [])).toBe("198.51.100.7");
  expect(clientIp(null, "198.51.100.7", [])).toBe("198.51.100.7");
});

test("behind a trusted proxy the nearest untrusted hop is the client", () => {
  expect(clientIp("203.0.113.9", "10.0.0.5", ["10.0.0.5"])).toBe("203.0.113.9");
  expect(clientIp("203.0.113.9, 10.0.0.6", "10.0.0.5", ["10.0.0.0/8"])).toBe("203.0.113.9");
  expect(clientIp("1.2.3.4, 203.0.113.9, 10.0.0.6", "10.0.0.5", ["10.0.0.0/8"])).toBe("203.0.113.9");
  expect(clientIp("garbage value", "10.0.0.5", ["10.0.0.5"])).toBe("10.0.0.5");
  expect(clientIp(null, "10.0.0.5", ["10.0.0.5"])).toBe("10.0.0.5");
});

test("a spoofed header from an untrusted peer never replaces the peer address", () => {
  expect(clientIp("127.0.0.1", "203.0.113.9", ["10.0.0.0/8"])).toBe("203.0.113.9");
  expect(clientIp("10.0.0.5", "203.0.113.9", ["10.0.0.5"])).toBe("203.0.113.9");
});
