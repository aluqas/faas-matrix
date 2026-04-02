import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildComplementTestIndex,
  buildRunSummaryArtifact,
  classifyComplementRun,
  extractTestsFromGoFile,
  resolveComplementPackages,
  topLevelTestName,
} from "./harness.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "complement-harness-"));
  tempDirs.push(dir);
  return dir;
}

describe("complement harness", () => {
  it("extracts top-level Go test names", () => {
    const tests = extractTestsFromGoFile(`
      package csapi

      func helper() {}
      func TestLogin(t *testing.T) {}
      func TestLoginWithRefresh(t *testing.T) {}
    `);

    expect(tests).toEqual(["TestLogin", "TestLoginWithRefresh"]);
  });

  it("builds a checked-in index from complement test packages", () => {
    const testsRoot = createTempDir();
    fs.writeFileSync(
      path.join(testsRoot, "root_test.go"),
      "package tests\nfunc TestTopLevel(t *testing.T) {}\n",
    );
    fs.mkdirSync(path.join(testsRoot, "csapi"), { recursive: true });
    fs.writeFileSync(
      path.join(testsRoot, "csapi", "account_test.go"),
      "package csapi\nfunc TestAddAccountData(t *testing.T) {}\nfunc TestShared(t *testing.T) {}\n",
    );
    fs.mkdirSync(path.join(testsRoot, "federation"), { recursive: true });
    fs.writeFileSync(
      path.join(testsRoot, "federation", "profile_test.go"),
      "package federation\nfunc TestShared(t *testing.T) {}\n",
    );

    expect(buildComplementTestIndex(testsRoot)).toEqual({
      TestAddAccountData: ["./tests/csapi"],
      TestShared: ["./tests/csapi", "./tests/federation"],
      TestTopLevel: ["./tests"],
    });
  });

  it("auto-resolves a unique package for explicit test names", () => {
    const resolution = resolveComplementPackages(
      {
        TestAddAccountData: ["./tests/csapi"],
      },
      ["TestAddAccountData/subcase"],
    );

    expect(resolution.packages).toEqual(["./tests/csapi"]);
    expect(resolution.missing).toEqual([]);
    expect(resolution.ambiguous).toEqual({});
    expect(resolution.resolvedByTest).toEqual({
      "TestAddAccountData/subcase": "./tests/csapi",
    });
  });

  it("reports ambiguous and missing explicit test names", () => {
    const resolution = resolveComplementPackages(
      {
        TestAmbiguous: ["./tests", "./tests/csapi"],
      },
      ["TestAmbiguous", "TestMissing"],
    );

    expect(resolution.packages).toEqual([]);
    expect(resolution.missing).toEqual(["TestMissing"]);
    expect(resolution.ambiguous).toEqual({
      TestAmbiguous: ["./tests", "./tests/csapi"],
    });
  });

  it("classifies startup flakes separately from implementation failures", () => {
    const logContent = [
      JSON.stringify({ Action: "run", Test: "TestMedia" }),
      JSON.stringify({ Action: "output", Test: "TestMedia", Output: "failed to deployBaseImage\n" }),
      JSON.stringify({ Action: "output", Test: "TestMedia", Output: "health: starting\n" }),
      JSON.stringify({ Action: "fail", Test: "TestMedia" }),
    ].join("\n");

    const classified = classifyComplementRun(logContent, "");
    expect(classified.overallClassification).toBe("startup_flake");
    expect(classified.failures).toEqual([
      {
        test: "TestMedia",
        classification: "startup_flake",
        reasons: ["deploy_base_image", "health_starting"],
      },
    ]);
  });

  it("classifies infrastructure failures from docker daemon/build problems", () => {
    const logContent = [
      JSON.stringify({ Action: "run", Test: "TestMedia" }),
      JSON.stringify({
        Action: "output",
        Test: "TestMedia",
        Output: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n",
      }),
      JSON.stringify({ Action: "fail", Test: "TestMedia" }),
    ].join("\n");

    const classified = classifyComplementRun(logContent, null);
    expect(classified.overallClassification).toBe("infra_flake");
    expect(classified.failures[0]).toMatchObject({
      test: "TestMedia",
      classification: "infra_flake",
      reasons: ["docker_daemon"],
    });
  });

  it("classifies assertion mismatches as implementation failures", () => {
    const logContent = [
      JSON.stringify({ Action: "run", Test: "TestSync" }),
      JSON.stringify({
        Action: "output",
        Test: "TestSync",
        Output: "expected 200 OK but got 404\n",
      }),
      JSON.stringify({ Action: "fail", Test: "TestSync" }),
    ].join("\n");

    const classified = classifyComplementRun(logContent, "[docker:hs1] booted\n");
    expect(classified.overallClassification).toBe("implementation_fail");
    expect(classified.failures[0]).toMatchObject({
      test: "TestSync",
      classification: "implementation_fail",
      reasons: ["assertion_or_behavior_mismatch"],
    });
  });

  it("does not treat ConstructBlueprint stack traces as startup flakes by themselves", () => {
    const logContent = [
      JSON.stringify({ Action: "run", Test: "TestPartialStateJoin" }),
      JSON.stringify({
        Action: "output",
        Test: "TestPartialStateJoin/Subcase",
        Output:
          "github.com/matrix-org/complement/internal/docker.(*Builder).ConstructBlueprintIfNotExist(...)\n",
      }),
      JSON.stringify({
        Action: "output",
        Test: "TestPartialStateJoin/Subcase",
        Output: "rooms.join.!room:hs1.state.events does not exist\n",
      }),
      JSON.stringify({ Action: "fail", Test: "TestPartialStateJoin" }),
    ].join("\n");

    const classified = classifyComplementRun(logContent, "[docker:hs1] startup.begin\n");
    expect(classified.overallClassification).toBe("implementation_fail");
    expect(classified.failures[0]).toMatchObject({
      test: "TestPartialStateJoin",
      classification: "implementation_fail",
      reasons: ["assertion_or_behavior_mismatch"],
    });
  });

  it("builds a compact run summary artifact with classification", () => {
    const logContent = [
      JSON.stringify({ Action: "run", Test: "TestSync" }),
      JSON.stringify({ Action: "pass", Test: "TestSync" }),
      JSON.stringify({ Action: "run", Test: "TestMedia" }),
      JSON.stringify({
        Action: "output",
        Test: "TestMedia",
        Output: "failed to deployBaseImage\n",
      }),
      JSON.stringify({ Action: "fail", Test: "TestMedia" }),
    ].join("\n");

    const summary = buildRunSummaryArtifact({
      logContent,
      dockerLogContent: "",
      packages: ["./tests/csapi"],
      filter: "TestSync|TestMedia",
      requestedTests: ["TestSync", "TestMedia"],
      fullRun: false,
      startupDebug: true,
      spawnTimeoutSeconds: 90,
    });

    expect(summary.packages).toEqual(["./tests/csapi"]);
    expect(summary.pass).toBe(1);
    expect(summary.fail).toBe(1);
    expect(summary.total).toBe(2);
    expect(summary.overallClassification).toBe("startup_flake");
    expect(summary.failedTests[0]?.classification).toBe("startup_flake");
  });

  it("keeps top-level names for subtests", () => {
    expect(topLevelTestName("TestSync/subcase/leaf")).toBe("TestSync");
  });
});
