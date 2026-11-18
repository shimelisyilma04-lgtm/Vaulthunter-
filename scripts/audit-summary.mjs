import { spawnSync } from "node:child_process";

const result = spawnSync("npm", ["audit", "--json"], {
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024
});

try {
  const report = JSON.parse(result.stdout || "{}");
  const vulnerabilities = report.vulnerabilities ?? {};
  console.log(JSON.stringify({
    event: "dependency_audit_summary",
    totals: report.metadata?.vulnerabilities ?? null,
    packages: Object.entries(vulnerabilities).map(([name, item]) => ({
      name,
      severity: item.severity,
      isDirect: item.isDirect,
      range: item.range,
      fixAvailable: item.fixAvailable,
      advisories: (item.via ?? []).map((entry) =>
        typeof entry === "string" ? entry : {
          title: entry.title,
          url: entry.url,
          range: entry.range
        }
      )
    }))
  }));
} catch {
  console.log(JSON.stringify({
    event: "dependency_audit_summary_unavailable",
    exitStatus: result.status,
    error: result.error?.message ?? null
  }));
}
