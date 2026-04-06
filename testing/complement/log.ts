import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Action = "pass" | "fail" | "skip";
export type TestResults = Record<string, Action>;

export interface Summary {
  pass: number;
  fail: number;
  skip: number;
  total: number;
  fails: string[];
}

export interface Delta {
  newPasses: string[];
  newFails: string[];
  appeared: string[];
}

export interface ParsedLog {
  name: string;
  /** ISO datetime truncated to minute, from file mtime */
  mtime: string;
  results: TestResults;
}

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------

/** Parse a go test -json log file into a TestResults map.
 *  Tests that were started (action="run") but never received a verdict
 *  (e.g. due to a panic killing the package) are recorded as "fail". */
export function parseLog(content: string, maxDepth = 0): TestResults {
  const results: TestResults = {};
  const started = new Set<string>();

  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const testName: string = obj.Test;
      if (!testName) continue;
      const depth = (testName.match(/\//g) ?? []).length;
      if (depth > maxDepth) continue;
      const action: string = obj.Action;
      if (action === "run") {
        started.add(testName);
      } else if (action === "pass" || action === "fail" || action === "skip") {
        results[testName] = action;
        started.delete(testName);
      }
    } catch {}
  }

  // Tests that started but never got a verdict (panic/crash)
  for (const testName of started) {
    results[testName] = "fail";
  }

  return results;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function summarize(results: TestResults): Summary {
  let pass = 0,
    fail = 0,
    skip = 0;
  const fails: string[] = [];
  for (const [test, action] of Object.entries(results)) {
    if (action === "pass") pass++;
    else if (action === "fail") {
      fail++;
      fails.push(test);
    } else if (action === "skip") skip++;
  }
  return { pass, fail, skip, total: pass + fail + skip, fails };
}

export function pct(n: number, t: number): number {
  return t ? Math.round((n / t) * 100) : 0;
}

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

export function categorize(testName: string): string {
  const top = testName.split("/")[0];
  if (/^TestMedia|^TestContent|^TestRemote.*Thumbnail/i.test(top)) return "media";
  if (/Spaces|^TestFederatedClientSpaces/i.test(top)) return "spaces";
  if (
    /Federation|^TestACL|^TestRemote|Remote(?:Join|Presence|Typing)|^TestJoinFederated|^TestBannedUser|ViaSendJoin|ViaSendKnock|GapFill|MissingEvents|AuthChain|^TestEventAuth|^TestNetworkPartition|^TestUnrejectRejected|^TestCorrupted|^TestInbound/i.test(
      top,
    )
  )
    return "federation";
  if (
    /^TestKnocking|^TestMSC|^TestKnockRestricted|^TestKnockRooms|^TestRestrictedRooms|^TestCannotSendKnock/i.test(
      top,
    )
  )
    return "msc";
  if (/^TestSync|^TestJumpToDate/i.test(top)) return "sync";
  if (/^TestLogin|^TestLogout|^TestRegister/i.test(top)) return "auth";
  if (/^TestRoom|^TestCreateRoom|^TestForget|^TestUnban/i.test(top)) return "rooms";
  if (/^TestAccount|^TestProfile|^TestPresence|^TestDevice|^TestPush/i.test(top)) return "cs-api";
  return "other";
}

export function byCat(fails: string[]): Array<[string, number]> {
  const cats: Record<string, number> = {};
  for (const f of fails) {
    const cat = categorize(f);
    cats[cat] = (cats[cat] ?? 0) + 1;
  }
  return Object.entries(cats).toSorted((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------------------
// Delta (before = older run, after = newer run)
// ---------------------------------------------------------------------------

export function delta(before: TestResults, after: TestResults): Delta {
  const all = new Set([...Object.keys(before), ...Object.keys(after)]);
  const newPasses: string[] = [];
  const newFails: string[] = [];
  const appeared: string[] = [];
  for (const t of all) {
    const b = before[t],
      a = after[t];
    if (b === "fail" && a === "pass") newPasses.push(t);
    else if (b === "pass" && a === "fail") newFails.push(t);
    else if (!b && a === "pass") appeared.push(t);
  }
  return { newPasses, newFails, appeared };
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

const LOG_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/;

/** Load datetime-named log files from logsDir, newest first. */
export function loadLogs(logsDir: string, maxDepth = 0, lastN = Infinity): ParsedLog[] {
  if (!fs.existsSync(logsDir)) return [];
  let files = fs
    .readdirSync(logsDir)
    .filter((f) => LOG_PATTERN.test(f))
    .toSorted()
    .toReversed();
  if (Number.isFinite(lastN)) files = files.slice(0, lastN);
  return files.map((f) => {
    const filepath = path.join(logsDir, f);
    const mtime = fs.statSync(filepath).mtime.toISOString().replace("T", " ").slice(0, 16);
    const content = fs.readFileSync(filepath, "utf8");
    return { name: f, mtime, results: parseLog(content, maxDepth) };
  });
}
