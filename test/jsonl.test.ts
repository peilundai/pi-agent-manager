import { describe, expect, it } from "vitest";
import { JsonlDecoder, encodeJsonl } from "../src/pi/jsonl";

describe("JsonlDecoder", () => {
  it("splits on LF only, strips CR and keeps Unicode separators inside records", () => {
    const records: unknown[] = [];
    const decoder = new JsonlDecoder((value) => records.push(value));
    decoder.push(Buffer.from('{"a":"x y"}\r\n{"b":'));
    decoder.push(Buffer.from("2}\n\n"));
    expect(records).toEqual([{ a: "x y" }, { b: 2 }]);
  });

  it("decodes multi-byte characters split across chunks", () => {
    const records: unknown[] = [];
    const decoder = new JsonlDecoder((value) => records.push(value));
    const bytes = Buffer.from('{"t":"π✓"}\n');
    decoder.push(bytes.subarray(0, 8));
    decoder.push(bytes.subarray(8));
    expect(records).toEqual([{ t: "π✓" }]);
  });

  it("reports invalid lines and flushes a final unterminated record", () => {
    const records: unknown[] = [];
    const invalid: string[] = [];
    const decoder = new JsonlDecoder((value) => records.push(value), (line) => invalid.push(line));
    decoder.push("not json\n{\"ok\":true}");
    decoder.end();
    expect(invalid).toEqual(["not json"]);
    expect(records).toEqual([{ ok: true }]);
  });

  it("drops oversized records and resumes on the next line", () => {
    const records: unknown[] = [];
    const invalid: string[] = [];
    const decoder = new JsonlDecoder((value) => records.push(value), (line) => invalid.push(line), 16);
    decoder.push('{"long":"aaaaaaaaaaaaaaaaaaaaaaaa');
    decoder.push('aaaa"}\n{"n":1}\n');
    expect(invalid).toHaveLength(1);
    expect(records).toEqual([{ n: 1 }]);
  });

  it("encodes one record per line", () => {
    expect(encodeJsonl({ type: "abort" })).toBe('{"type":"abort"}\n');
  });
});
